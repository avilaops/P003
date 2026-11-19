-- Tolerância da conciliação nota × pedido (D04/C5), em pontos-base. Zero = exato.
CREATE TABLE purchase_entry_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 price_tolerance_bps integer NOT NULL DEFAULT 0 CHECK (price_tolerance_bps BETWEEN 0 AND 10000),
 quantity_tolerance_bps integer NOT NULL DEFAULT 0 CHECK (quantity_tolerance_bps BETWEEN 0 AND 10000),
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purchase_entry_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_entry_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_entry_settings
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
  GRANT SELECT,INSERT,UPDATE ON purchase_entry_settings TO erp_next_app;
 END IF;
END $$;
