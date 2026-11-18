CREATE TABLE production_structures (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
    created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,product_id,version),
    FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE production_structure_items (
    tenant_id uuid NOT NULL, product_id uuid NOT NULL, version integer NOT NULL, component_id uuid NOT NULL,
    per_unit_micros bigint NOT NULL CHECK(per_unit_micros BETWEEN 1 AND 999999999999999999),
    PRIMARY KEY(tenant_id,product_id,version,component_id), CHECK(product_id<>component_id),
    FOREIGN KEY(tenant_id,product_id,version) REFERENCES production_structures(tenant_id,product_id,version),
    FOREIGN KEY(tenant_id,component_id) REFERENCES products(tenant_id,id)
);
ALTER TABLE production_orders ADD COLUMN bom_version integer, ADD COLUMN warehouse_id uuid, ADD COLUMN planned_on date,
    ADD FOREIGN KEY(tenant_id,product_id,bom_version) REFERENCES production_structures(tenant_id,product_id,version),
    ADD FOREIGN KEY(tenant_id,warehouse_id) REFERENCES warehouses(tenant_id,id);

CREATE TABLE production_postings (
    tenant_id uuid NOT NULL, id uuid NOT NULL, production_order_id uuid NOT NULL, produced_micros bigint NOT NULL CHECK(produced_micros>=0),
    loss_micros bigint NOT NULL CHECK(loss_micros>=0), minutes integer NOT NULL CHECK(minutes>=0),
    additional_cents bigint NOT NULL CHECK(additional_cents>=0), value_micros numeric(40,0) CHECK(value_micros>=0),
    receipt_id uuid, reason text NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,receipt_id), CHECK(produced_micros>0 OR loss_micros>0),
    CHECK((produced_micros>0)=(receipt_id IS NOT NULL)),
    FOREIGN KEY(tenant_id,production_order_id) REFERENCES production_orders(tenant_id,id),
    FOREIGN KEY(tenant_id,receipt_id) REFERENCES stock_movements(tenant_id,id)
);
CREATE INDEX production_postings_order ON production_postings(tenant_id,production_order_id,created_at,id);
CREATE TABLE production_posting_inputs (
    tenant_id uuid NOT NULL, posting_id uuid NOT NULL, movement_id uuid NOT NULL,
    PRIMARY KEY(tenant_id,posting_id,movement_id),
    FOREIGN KEY(tenant_id,posting_id) REFERENCES production_postings(tenant_id,id),
    FOREIGN KEY(tenant_id,movement_id) REFERENCES stock_movements(tenant_id,id)
);
CREATE TABLE production_posting_reversals (
    tenant_id uuid NOT NULL, posting_id uuid NOT NULL, reason text NOT NULL, actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,posting_id),
    FOREIGN KEY(tenant_id,posting_id) REFERENCES production_postings(tenant_id,id)
);
ALTER TABLE stock_movements DROP CONSTRAINT stock_production_source;
ALTER TABLE stock_movements ADD CONSTRAINT stock_production_source CHECK(production_order_id IS NULL OR
    (source_order_id IS NULL AND source_purchase_receipt_id IS NULL AND transfer_id IS NULL AND source_pos_sale_id IS NULL));

DO $$ DECLARE tbl text; BEGIN
    FOREACH tbl IN ARRAY ARRAY['production_structures','production_structure_items','production_postings','production_posting_inputs','production_posting_reversals'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
        EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes()',tbl);
        IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',tbl); END IF;
    END LOOP;
END $$;

CREATE VIEW production_component_reservations WITH(security_invoker=true) AS
    SELECT o.tenant_id,o.id AS production_order_id,i.component_id AS product_id,o.warehouse_id,
        div(i.per_unit_micros::numeric*o.quantity_micros+999999,1000000)-
        div(i.per_unit_micros::numeric*coalesce(p.run,0)+999999,1000000) AS quantity_micros
    FROM production_orders o JOIN production_structure_items i ON (i.tenant_id,i.product_id,i.version)=(o.tenant_id,o.product_id,o.bom_version)
    LEFT JOIN LATERAL(SELECT sum(p.produced_micros+p.loss_micros) AS run FROM production_postings p
        WHERE p.tenant_id=o.tenant_id AND p.production_order_id=o.id AND NOT EXISTS(SELECT 1 FROM production_posting_reversals r
            WHERE (r.tenant_id,r.posting_id)=(p.tenant_id,p.id))) p ON true
    WHERE o.status='open' AND coalesce(p.run,0)<o.quantity_micros;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN GRANT SELECT ON production_component_reservations TO erp_next_app; END IF;
END $$;

CREATE FUNCTION check_production_holds(company uuid, item uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM production_component_reservations r WHERE r.tenant_id=company AND r.product_id=item
        GROUP BY r.warehouse_id HAVING sum(r.quantity_micros)>0 AND sum(r.quantity_micros)+coalesce((
            SELECT sum(h.quantity_micros) FROM stock_location_reservations h WHERE h.tenant_id=company AND h.product_id=item AND h.warehouse_id=r.warehouse_id),0)
            >coalesce((SELECT p.quantity_micros FROM stock_positions p WHERE p.tenant_id=company AND p.product_id=item AND p.warehouse_id=r.warehouse_id),0)
    ) THEN RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Saldo disponível insuficiente para os componentes empenhados na produção'; END IF;
END $$;
CREATE FUNCTION enforce_production_holds() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item uuid;
BEGIN
    IF TG_TABLE_NAME='stock_movements' THEN
        PERFORM check_production_holds(NEW.tenant_id,NEW.product_id);
    ELSIF TG_TABLE_NAME='sales_orders' THEN
        IF NEW.status='confirmed' THEN FOR item IN SELECT product_id FROM sales_order_lines WHERE tenant_id=NEW.tenant_id AND order_id=NEW.id LOOP
            PERFORM check_production_holds(NEW.tenant_id,item); END LOOP; END IF;
    ELSE
        FOR item IN SELECT component_id FROM production_structure_items WHERE (tenant_id,product_id,version)=(NEW.tenant_id,NEW.product_id,NEW.bom_version) LOOP
            PERFORM check_production_holds(NEW.tenant_id,item); END LOOP;
        IF NEW.status='cancelled' AND EXISTS(SELECT 1 FROM production_postings p WHERE p.tenant_id=NEW.tenant_id AND p.production_order_id=NEW.id
            AND NOT EXISTS(SELECT 1 FROM production_posting_reversals r WHERE (r.tenant_id,r.posting_id)=(p.tenant_id,p.id))) THEN
            RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='Estorne o apontamento antes de cancelar a produção'; END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reserve_production_move AFTER INSERT ON stock_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_production_holds();
CREATE CONSTRAINT TRIGGER reserve_production_sales AFTER UPDATE OF status ON sales_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_production_holds();
CREATE CONSTRAINT TRIGGER reserve_production_order AFTER INSERT OR UPDATE OF status ON production_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_production_holds();
