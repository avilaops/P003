CREATE TABLE warranty_case_records (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    case_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('evidence','report','term')),
    title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
    info jsonb NOT NULL,
    content bytea,
    sha256 text,
    contract_id uuid,
    service_order_id uuid,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,case_id) REFERENCES warranty_cases(tenant_id,id),
    FOREIGN KEY (tenant_id,contract_id) REFERENCES commercial_contracts(tenant_id,id),
    FOREIGN KEY (tenant_id,service_order_id) REFERENCES warranty_service_orders(tenant_id,id),
    CHECK ((kind='evidence')=(content IS NOT NULL) AND (kind='evidence')=(sha256 IS NOT NULL)),
    CHECK (content IS NULL OR octet_length(content) BETWEEN 1 AND 10485760),
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CHECK ((kind='term')=(contract_id IS NOT NULL) AND (kind='report')=(service_order_id IS NOT NULL))
);
CREATE INDEX warranty_case_records_by_case ON warranty_case_records(tenant_id,case_id,created_at);
CREATE UNIQUE INDEX warranty_case_terms ON warranty_case_records(tenant_id,case_id,contract_id) WHERE kind='term';
CREATE UNIQUE INDEX warranty_case_evidence_digest ON warranty_case_records(tenant_id,case_id,sha256) WHERE kind='evidence';
ALTER TABLE warranty_case_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranty_case_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warranty_case_records
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE TRIGGER warranty_case_records_immutable BEFORE UPDATE OR DELETE ON warranty_case_records
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();
DO $$ BEGIN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT ON warranty_case_records TO erp_next_app;
    END IF;
END $$;
