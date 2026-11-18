ALTER TABLE fiscal_nfe_email_deliveries
    DROP CONSTRAINT fiscal_nfe_email_deliveries_tenant_id_document_id_fkey,
    ALTER COLUMN pdf_sha256 DROP NOT NULL,
    ADD COLUMN document_kind text NOT NULL DEFAULT 'nfe' CHECK (document_kind IN ('nfe','received-nfses','outgoing-nfses'));

ALTER TABLE fiscal_nfe_email_deliveries
    ADD COLUMN nfe_id uuid GENERATED ALWAYS AS (CASE WHEN document_kind='nfe' THEN document_id END) STORED,
    ADD COLUMN received_nfse_id uuid GENERATED ALWAYS AS (CASE WHEN document_kind='received-nfses' THEN document_id END) STORED,
    ADD COLUMN outgoing_nfse_id uuid GENERATED ALWAYS AS (CASE WHEN document_kind='outgoing-nfses' THEN document_id END) STORED,
    ADD FOREIGN KEY (tenant_id,nfe_id) REFERENCES fiscal_nfe_documents(tenant_id,id),
    ADD FOREIGN KEY (tenant_id,received_nfse_id) REFERENCES fiscal_received_nfses(tenant_id,id),
    ADD FOREIGN KEY (tenant_id,outgoing_nfse_id) REFERENCES fiscal_outgoing_nfse_issuances(tenant_id,id);

DROP INDEX fiscal_nfe_email_uncertain;
CREATE UNIQUE INDEX fiscal_nfe_email_uncertain ON fiscal_nfe_email_deliveries(tenant_id,document_kind,document_id) WHERE status='unknown';
