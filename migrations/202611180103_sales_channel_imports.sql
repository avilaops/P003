CREATE TABLE sales_order_imports (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    filename text NOT NULL,
    channel text NOT NULL,
    rows jsonb NOT NULL CHECK (jsonb_typeof(rows)='array'),
    results jsonb NOT NULL CHECK (jsonb_typeof(results)='array'),
    status text NOT NULL CHECK (status IN ('previewed','confirmed')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    confirmed_at timestamptz,
    PRIMARY KEY (tenant_id,id)
);
CREATE INDEX sales_order_imports_time ON sales_order_imports(tenant_id,created_at DESC,id DESC);
CREATE TABLE sales_channel_orders (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    channel text NOT NULL,
    external_number text NOT NULL,
    input_digest text NOT NULL,
    order_id uuid NOT NULL,
    import_id uuid NOT NULL,
    PRIMARY KEY(tenant_id,channel,external_number),
    UNIQUE(tenant_id,order_id),
    FOREIGN KEY(tenant_id,import_id) REFERENCES sales_order_imports(tenant_id,id),
    FOREIGN KEY(tenant_id,order_id) REFERENCES sales_orders(tenant_id,id)
);
DO $$
DECLARE tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['sales_order_imports','sales_channel_orders'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', tbl);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON sales_order_imports TO erp_next_app;
        GRANT SELECT,INSERT ON sales_channel_orders TO erp_next_app;
    END IF;
END $$;
