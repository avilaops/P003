CREATE TABLE finance_document_email_deliveries (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    context text NOT NULL CHECK(context IN ('receivable','report')),
    receivable_id uuid,
    source_revision bigint NOT NULL CHECK(source_revision > 0),
    subject_id text NOT NULL,
    command_key uuid NOT NULL,
    recipient text NOT NULL CHECK(char_length(recipient) BETWEEN 3 AND 254),
    subject text NOT NULL CHECK(char_length(subject) BETWEEN 1 AND 200),
    message text NOT NULL CHECK(char_length(message) BETWEEN 1 AND 10000),
    snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
    snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
    pdf_content bytea NOT NULL CHECK(octet_length(pdf_content)>0),
    pdf_sha256 text NOT NULL CHECK(pdf_sha256 ~ '^[0-9a-f]{64}$'),
    filename text NOT NULL,
    status text NOT NULL CHECK(status IN ('uncertain','sent','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,subject_id,command_key),
    FOREIGN KEY(tenant_id,receivable_id) REFERENCES receivables(tenant_id,id),
    CHECK((context='receivable' AND receivable_id IS NOT NULL) OR (context='report' AND receivable_id IS NULL)),
    CHECK(status<>'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX finance_document_email_history_idx ON finance_document_email_deliveries(tenant_id,context,receivable_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX finance_document_email_pending_idx ON finance_document_email_deliveries(tenant_id,context,(COALESCE(receivable_id,'00000000-0000-0000-0000-000000000000'::uuid))) WHERE status='uncertain';
ALTER TABLE finance_document_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_document_email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_document_email_isolation ON finance_document_email_deliveries
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Captured evidence and envelope remain immutable; only delivery outcome can advance.
CREATE FUNCTION preserve_finance_email_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Finance email history is preserved'; END IF;
    IF (to_jsonb(NEW)-'status'-'updated_at'-'sent_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'updated_at'-'sent_at')
        OR OLD.status <> 'uncertain' THEN
        RAISE EXCEPTION 'Finance email evidence is immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER finance_email_evidence BEFORE UPDATE OR DELETE ON finance_document_email_deliveries FOR EACH ROW EXECUTE FUNCTION preserve_finance_email_evidence();
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        REVOKE DELETE ON finance_document_email_deliveries FROM erp_next_app;
        GRANT SELECT,INSERT,UPDATE ON finance_document_email_deliveries TO erp_next_app;
    END IF;
END $$;
