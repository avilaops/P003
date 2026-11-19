CREATE TABLE sales_invoice_lots (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    order_id uuid NOT NULL,
    environment text NOT NULL CHECK (environment IN ('production','homologation')),
    draft_id uuid,
    withdrawn boolean NOT NULL DEFAULT false,
    legacy_full boolean NOT NULL DEFAULT false,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id,id),
    UNIQUE(tenant_id,id,order_id),
    UNIQUE(tenant_id,draft_id),
    FOREIGN KEY(tenant_id,order_id) REFERENCES sales_orders(tenant_id,id),
    FOREIGN KEY(tenant_id,draft_id,environment) REFERENCES fiscal_nfe_drafts(tenant_id,id,environment)
);
CREATE INDEX sales_invoice_lots_order ON sales_invoice_lots(tenant_id,order_id);
CREATE TABLE sales_invoice_lot_items (
    tenant_id uuid NOT NULL, lot_id uuid NOT NULL, order_id uuid NOT NULL, line_number integer NOT NULL,
    quantity_micros bigint NOT NULL CHECK (quantity_micros>0 AND quantity_micros%100=0),
    PRIMARY KEY(tenant_id,lot_id,line_number),
    FOREIGN KEY(tenant_id,lot_id,order_id) REFERENCES sales_invoice_lots(tenant_id,id,order_id),
    FOREIGN KEY(tenant_id,order_id,line_number) REFERENCES sales_order_lines(tenant_id,order_id,line_number)
);
CREATE TABLE sales_partial_returns (
    tenant_id uuid NOT NULL, id uuid NOT NULL, lot_id uuid NOT NULL,
    received_nfe_id bigint NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 200),
    destination text NOT NULL CHECK(destination IN ('stock','service','discard')),
    credited_cents bigint NOT NULL CHECK(credited_cents>=0), abated_cents bigint NOT NULL CHECK(abated_cents>=0),
    commission_reversed_cents bigint NOT NULL DEFAULT 0 CHECK(commission_reversed_cents>=0),
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
    UNIQUE(tenant_id,received_nfe_id), UNIQUE(tenant_id,id,lot_id),
    FOREIGN KEY(tenant_id,lot_id) REFERENCES sales_invoice_lots(tenant_id,id),
    FOREIGN KEY(tenant_id,received_nfe_id) REFERENCES fiscal_received_nfes(tenant_id,id)
);
CREATE TABLE sales_partial_return_items (
    tenant_id uuid NOT NULL, return_id uuid NOT NULL, lot_id uuid NOT NULL, line_number integer NOT NULL,
    quantity_micros bigint NOT NULL CHECK(quantity_micros>0), value_cents bigint NOT NULL CHECK(value_cents>=0),
    PRIMARY KEY(tenant_id,return_id,line_number),
    FOREIGN KEY(tenant_id,return_id,lot_id) REFERENCES sales_partial_returns(tenant_id,id,lot_id),
    FOREIGN KEY(tenant_id,lot_id,line_number) REFERENCES sales_invoice_lot_items(tenant_id,lot_id,line_number)
);
CREATE TABLE sales_return_abatements (
    tenant_id uuid NOT NULL, return_id uuid NOT NULL, receivable_id uuid NOT NULL,
    amount_cents bigint NOT NULL CHECK(amount_cents>0), PRIMARY KEY (tenant_id,return_id,receivable_id),
    FOREIGN KEY(tenant_id,return_id) REFERENCES sales_partial_returns(tenant_id,id),
    FOREIGN KEY(tenant_id,receivable_id) REFERENCES receivables(tenant_id,id)
);
DO $$ DECLARE name text; BEGIN
    FOREACH name IN ARRAY ARRAY['sales_invoice_lots','sales_invoice_lot_items','sales_partial_returns','sales_partial_return_items','sales_return_abatements'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',name);
        IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',name);
        END IF;
    END LOOP;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT UPDATE(draft_id,withdrawn,delivered_at) ON sales_invoice_lots TO erp_next_app;
    END IF;
END $$;


-- Commercial simulations preserve IPI separately in the fiscal price.
CREATE FUNCTION order_line_fiscal_price(s sales_order_lines) RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN c.order_id IS NOT NULL THEN (
        SELECT (item->>'unitNetCents')::bigint FROM jsonb_array_elements(c.public_snapshot#>'{sale,items}') item
         WHERE item->>'productId'=s.product_id::text AND item->>'sku'=s.sku AND item->>'unit'=s.unit
           AND (item->>'unitTotalCents')::bigint=s.price_cents AND (item->>'totalCents')::bigint=s.amount_cents
           AND (item->>'quantity')::numeric*1000000=s.quantity_micros)
      WHEN p.order_id IS NOT NULL THEN (p.snapshot#>>'{sale,unitWithoutIpiCents}')::bigint ELSE s.price_cents END
      FROM (SELECT 1) anchor
      LEFT JOIN commercial_order_quotes c ON c.tenant_id=s.tenant_id AND c.order_id=s.order_id
      LEFT JOIN order_pricing_snapshots p ON p.tenant_id=s.tenant_id AND p.order_id=s.order_id
$$;

-- A command key chosen when the lot is prepared binds its draft in the same
-- transaction as the normal idempotent draft creation. A failed check rolls both back.
CREATE FUNCTION verify_invoice_lot(lot sales_invoice_lots, draft uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE details jsonb; customer text; valid boolean;
BEGIN
    SELECT d.details,o.customer_tax_id INTO details,customer FROM fiscal_nfe_drafts d
    JOIN sales_orders o ON o.tenant_id=d.tenant_id AND o.id=lot.order_id
    WHERE d.tenant_id=lot.tenant_id AND d.id=draft AND d.model=55 AND d.environment=lot.environment AND o.status='confirmed';
    IF lot.withdrawn OR details IS NULL OR details->'recipient'->>'taxId' IS DISTINCT FROM customer
        OR coalesce(details->>'purpose','1')<>'1' OR details->>'sourceOrderId' IS NOT NULL THEN
        RAISE EXCEPTION 'Lote ou destinatário incompatível' USING ERRCODE='23514';
    END IF;
    WITH expected AS (
        SELECT s.sku,s.unit,l.quantity_micros AS qty,order_line_fiscal_price(s) AS price FROM sales_invoice_lot_items l JOIN sales_order_lines s USING(tenant_id,order_id,line_number)
        WHERE l.tenant_id=lot.tenant_id AND l.lot_id=lot.id
    ), supplied AS (
        SELECT j->>'code' AS sku,j->>'unit' AS unit,(j->>'quantity')::numeric*1000000 AS qty,(j->>'unitPrice')::numeric*100 AS price FROM jsonb_array_elements(details->'items') j
    )
    SELECT NOT EXISTS ((SELECT * FROM expected EXCEPT ALL SELECT * FROM supplied) UNION ALL (SELECT * FROM supplied EXCEPT ALL SELECT * FROM expected)) INTO valid;
    IF NOT valid THEN RAISE EXCEPTION 'Itens fiscais divergem do lote' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION bind_invoice_lot_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot sales_invoice_lots; draft uuid;
BEGIN
    SELECT * INTO lot FROM sales_invoice_lots WHERE tenant_id=NEW.tenant_id AND id=NEW.command_key FOR UPDATE;
    IF NOT FOUND THEN RETURN NEW; END IF;
    draft:=(NEW.result->'data'->>'id')::uuid;
    IF lot.draft_id IS NOT NULL THEN RAISE EXCEPTION 'Lote já vinculado' USING ERRCODE='23505'; END IF;
    PERFORM verify_invoice_lot(lot,draft);
    UPDATE sales_invoice_lots SET draft_id=draft WHERE tenant_id=lot.tenant_id AND id=lot.id;
    RETURN NEW;
END $$;
CREATE TRIGGER bind_invoice_lot AFTER INSERT ON domain_commands FOR EACH ROW
WHEN(NEW.scope='fiscal.nfe.draft.create') EXECUTE FUNCTION bind_invoice_lot_draft();

CREATE FUNCTION guard_sales_invoice_lot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot sales_invoice_lots;
BEGIN
    IF NEW.source_order_id IS NOT NULL AND EXISTS (
        SELECT FROM sales_invoice_lots l LEFT JOIN fiscal_nfe_documents e ON e.tenant_id=l.tenant_id AND e.id=l.draft_id
        WHERE l.tenant_id=NEW.tenant_id AND l.order_id=NEW.source_order_id AND l.environment=NEW.environment
            AND (l.delivered_at IS NOT NULL OR NOT l.withdrawn AND coalesce(e.status,'draft') NOT IN ('cancelled','rejected'))
    ) THEN RAISE EXCEPTION 'Pedido possui lotes fiscais' USING ERRCODE='23514'; END IF;
    SELECT * INTO lot FROM sales_invoice_lots WHERE tenant_id=NEW.tenant_id AND draft_id=NEW.id;
    IF FOUND THEN PERFORM verify_invoice_lot(lot,NEW.id); END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER validate_sales_invoice_lot BEFORE INSERT ON fiscal_nfe_documents FOR EACH ROW EXECUTE FUNCTION guard_sales_invoice_lot();

CREATE FUNCTION order_line_delivered(company uuid, sale uuid, line integer) RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT coalesce(sum(i.quantity_micros),0)::bigint FROM sales_invoice_lot_items i JOIN sales_invoice_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
    WHERE i.tenant_id=company AND i.order_id=sale AND i.line_number=line AND l.delivered_at IS NOT NULL AND l.environment='production'
$$;
-- The full-order cancellation operation reverses every item. It cannot be combined with physical partial movements.
CREATE FUNCTION guard_partial_order_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT FROM sales_invoice_lots l LEFT JOIN fiscal_nfe_documents d ON d.tenant_id=l.tenant_id AND d.id=l.draft_id
        WHERE l.tenant_id=NEW.tenant_id AND l.order_id=NEW.id AND l.environment='production' AND (NOT l.legacy_full OR EXISTS(SELECT FROM sales_partial_returns r WHERE r.tenant_id=l.tenant_id AND r.lot_id=l.id)) AND
        (l.delivered_at IS NOT NULL OR NOT l.withdrawn AND coalesce(d.status,'draft') NOT IN ('rejected','cancelled'))) THEN
        RAISE EXCEPTION 'Concilie os lotes fiscais e as devoluções do pedido' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER validate_partial_order_cancellation BEFORE UPDATE OF status ON sales_orders FOR EACH ROW
WHEN(NEW.status='cancelled' AND OLD.status<>'cancelled') EXECUTE FUNCTION guard_partial_order_cancellation();

CREATE FUNCTION prevent_return_as_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT FROM sales_partial_returns r WHERE r.tenant_id=NEW.tenant_id AND r.received_nfe_id=NEW.received_nfe_id) THEN
        RAISE EXCEPTION 'Entrada já conciliada como devolução' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER check_returned_nfe_purchase BEFORE INSERT ON fiscal_received_purchase_links FOR EACH ROW EXECUTE FUNCTION prevent_return_as_purchase();

-- Completed full-order sales keep their original invoice identity and delivery.
-- Materialization also makes older invoices eligible for the same item-level return checks.
CREATE FUNCTION register_delivered_full_invoice(company uuid, sale uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE invoice uuid;
BEGIN
    FOR invoice IN INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment,draft_id,legacy_full,delivered_at)
        SELECT o.tenant_id,d.id,o.id,'production',d.id,true,o.updated_at FROM sales_orders o JOIN fiscal_nfe_documents d ON d.tenant_id=o.tenant_id AND d.source_order_id=o.id
        WHERE o.tenant_id=company AND o.id=sale AND o.status='completed' AND d.status='authorized' AND d.model=55 AND d.environment='production'
        ON CONFLICT DO NOTHING RETURNING id
    LOOP
        INSERT INTO sales_invoice_lot_items(tenant_id,lot_id,order_id,line_number,quantity_micros)
        SELECT tenant_id,invoice,order_id,line_number,quantity_micros FROM sales_order_lines WHERE tenant_id=company AND order_id=sale;
    END LOOP;
END $$;
CREATE FUNCTION register_order_full_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM register_delivered_full_invoice(NEW.tenant_id,NEW.id); RETURN NEW; END $$;
CREATE TRIGGER capture_delivered_full_invoice AFTER UPDATE OF status ON sales_orders FOR EACH ROW
WHEN(NEW.status='completed' AND OLD.status<>'completed') EXECUTE FUNCTION register_order_full_invoice();
CREATE FUNCTION register_invoice_full_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM register_delivered_full_invoice(NEW.tenant_id,NEW.source_order_id); RETURN NEW; END $$;
CREATE TRIGGER capture_authorized_full_order AFTER INSERT OR UPDATE OF status ON fiscal_nfe_documents FOR EACH ROW
WHEN(NEW.source_order_id IS NOT NULL AND NEW.status='authorized' AND NEW.environment='production') EXECUTE FUNCTION register_invoice_full_order();
SELECT register_delivered_full_invoice(d.tenant_id,d.source_order_id) FROM fiscal_nfe_documents d JOIN sales_orders o ON o.tenant_id=d.tenant_id AND o.id=d.source_order_id
    WHERE d.status='authorized' AND d.model=55 AND d.environment='production' AND o.status='completed';

CREATE FUNCTION guard_lot_draft_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lot sales_invoice_lots;
BEGIN
    SELECT * INTO lot FROM sales_invoice_lots WHERE tenant_id=NEW.tenant_id AND draft_id=NEW.id AND NOT legacy_full;
    IF FOUND THEN PERFORM verify_invoice_lot(lot,NEW.id); END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER validate_lot_draft_update AFTER UPDATE OF details,environment,model ON fiscal_nfe_drafts FOR EACH ROW EXECUTE FUNCTION guard_lot_draft_update();
