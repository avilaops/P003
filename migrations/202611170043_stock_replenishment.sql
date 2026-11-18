CREATE TABLE stock_replenishment_rules (
    tenant_id uuid NOT NULL,
    product_id uuid NOT NULL,
    minimum_micros bigint NOT NULL CHECK (minimum_micros BETWEEN 0 AND 999999999999999999),
    reorder_micros bigint NOT NULL CHECK (reorder_micros BETWEEN minimum_micros AND 999999999999999999),
    lot_micros bigint NOT NULL CHECK (lot_micros BETWEEN 0 AND 999999999999999999),
    lead_days integer NOT NULL CHECK (lead_days BETWEEN 0 AND 3650),
    revision bigint NOT NULL CHECK (revision>0),
    PRIMARY KEY (tenant_id,product_id),
    FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
ALTER TABLE stock_replenishment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_replenishment_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_replenishment_rules
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON stock_replenishment_rules TO erp_next_app;
    END IF;
END $$;
