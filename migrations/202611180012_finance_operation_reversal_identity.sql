ALTER TABLE finance_operation_reversals
    ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD UNIQUE(tenant_id,id);
CREATE TRIGGER preserve_finance_operation_reversal BEFORE UPDATE OR DELETE ON finance_operation_reversals
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
