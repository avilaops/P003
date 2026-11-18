CREATE TABLE document_copy_email_deliveries (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    payable_id uuid,
    contract_id uuid,
    subject_id text NOT NULL,
    command_key uuid NOT NULL,
    source_revision bigint NOT NULL CHECK (source_revision > 0),
    snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
    recipients text[] NOT NULL CHECK (cardinality(recipients) > 0),
    subject text NOT NULL,
    message text NOT NULL,
    manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='array' AND jsonb_array_length(manifest)>0),
    payable_pdf bytea,
    status text NOT NULL DEFAULT 'uncertain' CHECK (status IN ('uncertain','sent','failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at timestamptz,
    CHECK (num_nonnulls(payable_id,contract_id)=1),
    CHECK ((payable_id IS NOT NULL)=(payable_pdf IS NOT NULL)),
    CHECK ((status='sent')=(sent_at IS NOT NULL)),
    UNIQUE(tenant_id,subject_id,command_key),
    FOREIGN KEY(tenant_id,payable_id) REFERENCES payables(tenant_id,id),
    FOREIGN KEY(tenant_id,contract_id) REFERENCES commercial_contracts(tenant_id,id)
);
CREATE INDEX document_copy_payable_history ON document_copy_email_deliveries(tenant_id,payable_id,created_at DESC) WHERE payable_id IS NOT NULL;
CREATE INDEX document_copy_contract_history ON document_copy_email_deliveries(tenant_id,contract_id,created_at DESC) WHERE contract_id IS NOT NULL;
CREATE UNIQUE INDEX document_copy_payable_pending ON document_copy_email_deliveries(tenant_id,payable_id) WHERE status='uncertain';
CREATE UNIQUE INDEX document_copy_contract_pending ON document_copy_email_deliveries(tenant_id,contract_id) WHERE status='uncertain';
ALTER TABLE document_copy_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_copy_email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY document_copy_tenant ON document_copy_email_deliveries
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE(status,sent_at) ON document_copy_email_deliveries TO erp_next_app;
    END IF;
END $$;
