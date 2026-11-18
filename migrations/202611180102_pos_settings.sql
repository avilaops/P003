CREATE TABLE pos_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    enabled boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);
ALTER TABLE pos_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_settings_tenant ON pos_settings
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON pos_settings TO erp_next_app;
    END IF;
END $$;
