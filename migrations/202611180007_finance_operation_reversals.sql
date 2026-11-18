CREATE TABLE finance_operation_reversals (
    tenant_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    occurred_on date NOT NULL,
    reason text NOT NULL,
    recorded_by text NOT NULL,
    entry_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, operation_id),
    FOREIGN KEY (tenant_id, operation_id) REFERENCES finance_operations(tenant_id,id),
    FOREIGN KEY (tenant_id, entry_id) REFERENCES financial_account_entries(tenant_id,id)
);
ALTER TABLE finance_operation_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_operation_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON finance_operation_reversals
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE VIEW finance_active_operations WITH (security_invoker=true) AS
 SELECT op.* FROM finance_operations op
 WHERE NOT EXISTS (
    SELECT FROM finance_operation_reversals rev
    WHERE (rev.tenant_id,rev.operation_id)=(op.tenant_id,op.id)
 );
DO $$ BEGIN
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
   GRANT SELECT,INSERT ON finance_operation_reversals TO erp_next_app;
   GRANT SELECT ON finance_active_operations TO erp_next_app;
 END IF;
END $$;
