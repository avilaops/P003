-- Revision, proof and base tables remain append-only. The application can remove
-- temporary jobs after their upload was accepted or its quarantine has elapsed.
CREATE POLICY signature_job_retention ON contract_signature_jobs AS RESTRICTIVE FOR DELETE
USING (kind='increment' AND status IN ('completed','rejected') AND EXISTS (
    SELECT 1 FROM contract_signature_uploads u
    WHERE (u.tenant_id,u.envelope_id,u.id)=(contract_signature_jobs.tenant_id,contract_signature_jobs.envelope_id,contract_signature_jobs.upload_id)
      AND (u.status='accepted' OR (u.status IN ('expired','rejected') AND u.quarantine_until<=clock_timestamp()))
));
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT DELETE ON contract_signature_jobs TO erp_next_app;
    END IF;
END $$;
