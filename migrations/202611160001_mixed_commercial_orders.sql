-- A mixed quote has no single representative version. Historical rows keep theirs.
ALTER TABLE commercial_order_quotes ALTER COLUMN price_version_id DROP NOT NULL;
CREATE TABLE commercial_order_quote_versions (
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    product_line text NOT NULL CHECK(product_line IN ('imported','national')),
    version_id uuid NOT NULL,
    version_snapshot jsonb NOT NULL CHECK(jsonb_typeof(version_snapshot)='object'),
    PRIMARY KEY(tenant_id,order_id,product_line),
    FOREIGN KEY(tenant_id,order_id) REFERENCES commercial_order_quotes(tenant_id,order_id),
    FOREIGN KEY(tenant_id,product_line,version_id) REFERENCES price_table_versions(tenant_id,product_line,id)
);
CREATE TRIGGER mixed_commercial_versions_immutable BEFORE UPDATE OR DELETE ON commercial_order_quote_versions FOR EACH ROW EXECUTE FUNCTION reject_price_history_changes();
ALTER TABLE commercial_order_quote_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_order_quote_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY mixed_commercial_versions_isolation ON commercial_order_quote_versions
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT ON commercial_order_quote_versions TO erp_next_app;
    END IF;
END $$;
