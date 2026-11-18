CREATE TABLE fiscal_nfe_email_deliveries (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    auth_subject text NOT NULL,
    command_key uuid NOT NULL,
    confirmed_etag text NOT NULL,
    recipient text NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 254),
    xml_sha256 text NOT NULL CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
    pdf_sha256 text NOT NULL CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('unknown','sent','failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at timestamptz,
    CHECK ((status='sent')=(sent_at IS NOT NULL)),
    UNIQUE (tenant_id,auth_subject,command_key),
    FOREIGN KEY (tenant_id,document_id) REFERENCES fiscal_nfe_documents(tenant_id,id)
);
CREATE INDEX fiscal_nfe_email_history ON fiscal_nfe_email_deliveries(tenant_id,document_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX fiscal_nfe_email_uncertain ON fiscal_nfe_email_deliveries(tenant_id,document_id) WHERE status='unknown';
ALTER TABLE fiscal_nfe_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_nfe_email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_nfe_email_tenant ON fiscal_nfe_email_deliveries
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE(status,sent_at) ON fiscal_nfe_email_deliveries TO erp_next_app;
    END IF;
END $$;
