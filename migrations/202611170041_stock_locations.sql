-- Historical movements keep their original evidence. The opening location owns
-- the consolidated quantity left after subtracting the other physical locations.
CREATE TABLE stock_location_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    enabled boolean NOT NULL DEFAULT false,
    opening_id uuid NOT NULL,
    sales_id uuid NOT NULL,
    purchase_id uuid NOT NULL,
    production_id uuid NOT NULL,
    revision bigint NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id,opening_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY (tenant_id,sales_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY (tenant_id,purchase_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY (tenant_id,production_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE stock_location_balances (
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    warehouse_id uuid NOT NULL,
    quantity_micros bigint NOT NULL CHECK (quantity_micros BETWEEN 0 AND 999999999999999999),
    PRIMARY KEY (tenant_id,product_id,warehouse_id),
    FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
    FOREIGN KEY (tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id)
);
CREATE TABLE stock_transfers (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
    reverses_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    UNIQUE (tenant_id,reverses_id),
    FOREIGN KEY (tenant_id,from_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY (tenant_id,to_id) REFERENCES warehouses(tenant_id,id),
    FOREIGN KEY (tenant_id,reverses_id) REFERENCES stock_transfers(tenant_id,id),
    CHECK (from_id <> to_id)
);
CREATE INDEX stock_transfer_date ON stock_transfers(tenant_id,created_at DESC,id);
CREATE TRIGGER stock_transfer_immutable BEFORE UPDATE OR DELETE ON stock_transfers
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
ALTER TABLE stock_movements
    ADD COLUMN warehouse_id uuid,
    ADD COLUMN local_balance_after_micros bigint CHECK (local_balance_after_micros >= 0),
    ADD COLUMN transfer_id uuid,
    ADD FOREIGN KEY (tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id),
    ADD FOREIGN KEY (tenant_id,transfer_id) REFERENCES stock_transfers(tenant_id,id);
CREATE UNIQUE INDEX stock_transfer_leg ON stock_movements(tenant_id,transfer_id,product_id,direction)
    WHERE transfer_id IS NOT NULL;
CREATE INDEX stock_movements_location_date ON stock_movements(tenant_id,warehouse_id,product_id,created_at DESC,id);
ALTER TABLE sales_order_lines ADD COLUMN warehouse_id uuid,
    ADD FOREIGN KEY (tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id);

DO $$
DECLARE rel text;
BEGIN
    FOREACH rel IN ARRAY ARRAY['stock_location_settings','stock_location_balances','stock_transfers'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',rel);
    END LOOP;
END $$;

CREATE FUNCTION ensure_stock_location(company uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE chosen uuid; candidate text := 'PRINCIPAL';
BEGIN
    SELECT opening_id INTO chosen FROM stock_location_settings WHERE tenant_id=company;
    IF FOUND THEN RETURN chosen; END IF;
    PERFORM id FROM tenants WHERE id=company FOR UPDATE;
    SELECT opening_id INTO chosen FROM stock_location_settings WHERE tenant_id=company;
    IF FOUND THEN RETURN chosen; END IF;
    SELECT id INTO chosen FROM warehouses WHERE tenant_id=company AND code=candidate AND status='active';
    IF chosen IS NULL THEN
        WHILE EXISTS (SELECT 1 FROM warehouses WHERE tenant_id=company AND code=candidate) LOOP
            candidate := 'PRINCIPAL-' || upper(left(gen_random_uuid()::text,8));
        END LOOP;
        INSERT INTO warehouses(tenant_id,id,code,name,status,revision)
            VALUES(company,gen_random_uuid(),candidate,'Principal','active',1) RETURNING id INTO chosen;
    END IF;
    INSERT INTO stock_location_settings(tenant_id,opening_id,sales_id,purchase_id,production_id)
        VALUES(company,chosen,chosen,chosen,chosen);
    RETURN chosen;
END $$;

DO $migration$
DECLARE company uuid; prior text := coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY stock_location_bootstrap ON tenants FOR SELECT TO %I USING (true)',current_user);
    FOR company IN SELECT id FROM tenants ORDER BY id LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        PERFORM ensure_stock_location(company);
    END LOOP;
    PERFORM set_config('app.tenant_id',prior,true);
    DROP POLICY stock_location_bootstrap ON tenants;
END $migration$;

CREATE FUNCTION prepare_stock_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM ensure_stock_location(NEW.tenant_id);
    RETURN NEW;
END $$;
CREATE TRIGGER prepare_stock_opening BEFORE INSERT ON stock_balances FOR EACH ROW EXECUTE FUNCTION prepare_stock_opening();

CREATE VIEW stock_positions WITH (security_invoker=true) AS
    SELECT b.tenant_id,b.product_id,c.opening_id AS warehouse_id,
           (b.quantity_micros - coalesce((SELECT sum(l.quantity_micros) FROM stock_location_balances l
               WHERE l.tenant_id=b.tenant_id AND l.product_id=b.product_id),0))::bigint AS quantity_micros
    FROM stock_balances b JOIN stock_location_settings c ON c.tenant_id=b.tenant_id
    UNION ALL SELECT tenant_id,product_id,warehouse_id,quantity_micros FROM stock_location_balances;
CREATE VIEW stock_location_reservations WITH (security_invoker=true) AS
    SELECT l.tenant_id,l.product_id,coalesce(l.warehouse_id,c.opening_id) AS warehouse_id,l.order_id,l.quantity_micros
    FROM sales_order_lines l JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id
    JOIN stock_location_settings c ON c.tenant_id=l.tenant_id WHERE o.status='confirmed';

-- Both active versions update the consolidated position in the same transaction
-- before appending a movement. This projection also covers existing integrations.
CREATE FUNCTION locate_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prefs stock_location_settings%ROWTYPE; chosen uuid; original_transfer uuid; leg uuid; local_after bigint; held numeric;
BEGIN
    PERFORM ensure_stock_location(NEW.tenant_id);
    SELECT * INTO STRICT prefs FROM stock_location_settings WHERE tenant_id=NEW.tenant_id;
    IF NEW.reverses_id IS NOT NULL THEN
        SELECT coalesce(warehouse_id,prefs.opening_id),transfer_id INTO chosen,original_transfer FROM stock_movements
            WHERE tenant_id=NEW.tenant_id AND id=NEW.reverses_id;
        IF original_transfer IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM stock_transfers WHERE tenant_id=NEW.tenant_id AND id=NEW.transfer_id AND reverses_id=original_transfer
        ) THEN RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Estorne as duas movimentações pelo documento de transferência'; END IF;
        -- A historical sale can legitimately be returned after closing its store.
        -- The reversal retains the original document and records the actual receiving location.
        IF NEW.direction='receipt' AND original_transfer IS NULL AND (NOT prefs.enabled OR NOT EXISTS (
            SELECT 1 FROM warehouses WHERE tenant_id=NEW.tenant_id AND id=chosen AND status='active'
        )) THEN chosen := prefs.opening_id; END IF;
    ELSIF NEW.source_order_id IS NOT NULL THEN
        SELECT coalesce(warehouse_id,prefs.opening_id) INTO chosen FROM sales_order_lines
            WHERE tenant_id=NEW.tenant_id AND order_id=NEW.source_order_id AND product_id=NEW.product_id;
    END IF;
    IF NEW.transfer_id IS NOT NULL THEN
        SELECT CASE NEW.direction WHEN 'issue' THEN from_id ELSE to_id END INTO STRICT leg FROM stock_transfers
            WHERE tenant_id=NEW.tenant_id AND id=NEW.transfer_id;
        IF chosen IS NOT NULL AND chosen<>leg THEN RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Depósito divergente no estorno'; END IF;
        chosen := leg;
    END IF;
    IF NEW.warehouse_id IS NOT NULL AND chosen IS NOT NULL AND NEW.warehouse_id<>chosen THEN
        RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Depósito divergente do documento';
    END IF;
    NEW.warehouse_id := coalesce(chosen,NEW.warehouse_id,CASE
        WHEN NOT prefs.enabled THEN prefs.opening_id
        WHEN NEW.source_purchase_receipt_id IS NOT NULL THEN prefs.purchase_id
        WHEN NEW.production_order_id IS NOT NULL THEN prefs.production_id
        WHEN NEW.source_pos_sale_id IS NOT NULL THEN prefs.sales_id ELSE prefs.opening_id END);
    IF (NEW.warehouse_id<>prefs.opening_id AND NOT prefs.enabled) OR NOT EXISTS
        (SELECT 1 FROM warehouses WHERE tenant_id=NEW.tenant_id AND id=NEW.warehouse_id AND status='active') THEN
        RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Depósito indisponível';
    END IF;
    IF NEW.warehouse_id=prefs.opening_id THEN
        SELECT NEW.balance_after_micros-coalesce(sum(quantity_micros),0) INTO local_after
            FROM stock_location_balances WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id;
    ELSIF NEW.direction='receipt' THEN
        INSERT INTO stock_location_balances AS b(tenant_id,product_id,warehouse_id,quantity_micros)
        VALUES(NEW.tenant_id,NEW.product_id,NEW.warehouse_id,NEW.quantity_micros)
        ON CONFLICT (tenant_id,product_id,warehouse_id) DO UPDATE SET quantity_micros=b.quantity_micros+excluded.quantity_micros
        RETURNING quantity_micros INTO local_after;
    ELSE
        UPDATE stock_location_balances SET quantity_micros=quantity_micros-NEW.quantity_micros
        WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND warehouse_id=NEW.warehouse_id
            AND quantity_micros>=NEW.quantity_micros RETURNING quantity_micros INTO local_after;
    END IF;
    IF local_after IS NULL OR local_after<0 THEN RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Saldo insuficiente no depósito'; END IF;
    IF prefs.enabled AND NEW.direction='issue' THEN
        SELECT coalesce(sum(quantity_micros),0) INTO held FROM stock_location_reservations
            WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id AND warehouse_id=NEW.warehouse_id
            AND order_id IS DISTINCT FROM NEW.source_order_id;
        IF local_after<held THEN RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Quantidade reservada no depósito'; END IF;
    END IF;
    NEW.local_balance_after_micros := local_after;
    RETURN NEW;
END $$;
CREATE TRIGGER stock_location_on_movement BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION locate_stock_movement();

CREATE FUNCTION assign_stock_order_locations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prefs stock_location_settings%ROWTYPE;
BEGIN
    IF NEW.status<>'confirmed' OR OLD.status='confirmed' THEN RETURN NEW; END IF;
    PERFORM ensure_stock_location(NEW.tenant_id);
    SELECT * INTO STRICT prefs FROM stock_location_settings WHERE tenant_id=NEW.tenant_id;
    UPDATE sales_order_lines SET warehouse_id=CASE WHEN prefs.enabled THEN prefs.sales_id ELSE prefs.opening_id END
        WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id AND warehouse_id IS NULL;
    IF prefs.enabled AND EXISTS (
        SELECT 1 FROM sales_order_lines l JOIN warehouses w ON w.tenant_id=l.tenant_id AND w.id=l.warehouse_id
        LEFT JOIN stock_positions p ON p.tenant_id=l.tenant_id AND p.product_id=l.product_id AND p.warehouse_id=l.warehouse_id
        WHERE l.tenant_id=NEW.tenant_id AND l.order_id=NEW.id AND (w.status<>'active' OR l.quantity_micros+
            (SELECT coalesce(sum(r.quantity_micros),0) FROM stock_location_reservations r WHERE r.tenant_id=l.tenant_id
                AND r.product_id=l.product_id AND r.warehouse_id=l.warehouse_id AND r.order_id<>l.order_id)>coalesce(p.quantity_micros,0))
    ) THEN RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Saldo disponível insuficiente no depósito para reservar o pedido'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER stock_location_on_confirmation BEFORE UPDATE OF status ON sales_orders
    FOR EACH ROW EXECUTE FUNCTION assign_stock_order_locations();

CREATE FUNCTION protect_stock_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status='archived' AND OLD.status='active' AND (
        EXISTS (SELECT 1 FROM stock_location_settings WHERE tenant_id=NEW.tenant_id AND NEW.id IN (opening_id,sales_id,purchase_id,production_id))
        OR EXISTS (SELECT 1 FROM stock_positions WHERE tenant_id=NEW.tenant_id AND warehouse_id=NEW.id AND quantity_micros<>0)
        OR EXISTS (SELECT 1 FROM stock_location_reservations WHERE tenant_id=NEW.tenant_id AND warehouse_id=NEW.id)
    ) THEN RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='Depósito em uso no estoque'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER check_stock_location_archive BEFORE UPDATE OF status ON warehouses FOR EACH ROW EXECUTE FUNCTION protect_stock_location();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON stock_location_settings,stock_location_balances TO erp_next_app;
        GRANT SELECT,INSERT ON stock_transfers TO erp_next_app;
        GRANT SELECT ON stock_positions,stock_location_reservations TO erp_next_app;
    END IF;
END $$;
