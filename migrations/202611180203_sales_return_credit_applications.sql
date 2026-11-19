CREATE TABLE sales_return_credit_applications (
    tenant_id uuid NOT NULL, id uuid NOT NULL, return_id uuid NOT NULL, receivable_id uuid NOT NULL,
    amount_cents bigint NOT NULL CHECK(amount_cents>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,return_id) REFERENCES sales_partial_returns(tenant_id,id),
    FOREIGN KEY(tenant_id,receivable_id) REFERENCES receivables(tenant_id,id)
);
CREATE INDEX sales_return_credit_uses ON sales_return_credit_applications(tenant_id,return_id);
ALTER TABLE sales_return_credit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_return_credit_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sales_return_credit_applications
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER immutable_return_credit_use BEFORE UPDATE OR DELETE ON sales_return_credit_applications
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
DO $$ BEGIN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT ON sales_return_credit_applications TO erp_next_app;
    END IF;
END $$;
