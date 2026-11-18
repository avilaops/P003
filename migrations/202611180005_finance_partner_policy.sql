CREATE TABLE finance_partner_credit (
    tenant_id uuid NOT NULL,
    party_id uuid NOT NULL,
    limit_cents bigint NOT NULL CHECK (limit_cents BETWEEN 0 AND 99999999999999),
    revision bigint NOT NULL DEFAULT 2 CHECK (revision>0),
    PRIMARY KEY (tenant_id,party_id),
    FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id)
);
ALTER TABLE finance_partner_credit ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_partner_credit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance_partner_credit USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $grants$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
   GRANT SELECT,INSERT,UPDATE ON finance_partner_credit TO erp_next_app;
   GRANT SELECT,INSERT ON finance_operations,finance_operation_items TO erp_next_app;
   GRANT SELECT ON finance_portfolio TO erp_next_app;
 END IF;
END $grants$;
