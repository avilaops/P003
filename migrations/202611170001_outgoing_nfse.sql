CREATE TABLE fiscal_outgoing_nfse_issuances (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    external_id text NOT NULL CHECK (char_length(btrim(external_id)) BETWEEN 1 AND 120),
    environment text NOT NULL CHECK (environment IN ('homologation','production')),
    status text NOT NULL CHECK (status IN ('pending','processing','authorized','rejected','uncertain','cancelled')),
    request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    request_snapshot jsonb NOT NULL CHECK (jsonb_typeof(request_snapshot) = 'object'),
    dps_id char(45) NOT NULL CHECK (dps_id ~ '^DPS[0-9]{42}$'),
    access_key char(50) CHECK (access_key ~ '^[0-9]{50}$'),
    nfse_number text CHECK (nfse_number IS NULL OR char_length(btrim(nfse_number)) BETWEEN 1 AND 50),
    issued_at timestamptz,
    xml text CHECK (xml IS NULL OR octet_length(xml) BETWEEN 1 AND 1048576),
    xml_sha256 char(64) CHECK (xml_sha256 IS NULL OR xml_sha256 ~ '^[0-9a-f]{64}$'),
    error_code text CHECK (error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 80),
    error_message text CHECK (error_message IS NULL OR char_length(error_message) BETWEEN 1 AND 500),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by_subject text NOT NULL CHECK (char_length(created_by_subject) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    UNIQUE (tenant_id,external_id),
    UNIQUE (tenant_id,access_key),
    CHECK ((status IN ('authorized','cancelled')) = (access_key IS NOT NULL AND xml IS NOT NULL AND xml_sha256 IS NOT NULL)),
    CHECK (request_snapshot->>'externalId' IS NOT DISTINCT FROM external_id),
    CHECK (request_snapshot->>'environment' IS NOT DISTINCT FROM environment)
);

CREATE INDEX fiscal_outgoing_nfse_status_idx
    ON fiscal_outgoing_nfse_issuances(tenant_id,status,updated_at,id);

CREATE TABLE fiscal_outgoing_nfse_sequences (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    series integer NOT NULL CHECK (series BETWEEN 1 AND 99999),
    next_number bigint NOT NULL CHECK (next_number BETWEEN 1 AND 999999999999999),
    PRIMARY KEY (tenant_id,series)
);

CREATE FUNCTION fiscal_outgoing_nfse_request_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.external_id IS DISTINCT FROM OLD.external_id
        OR NEW.environment IS DISTINCT FROM OLD.environment
        OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
        OR NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot
        OR NEW.dps_id IS DISTINCT FROM OLD.dps_id
        OR NEW.created_by_subject IS DISTINCT FROM OLD.created_by_subject
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'NFS-e request snapshot is immutable';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'NFS-e revision must advance exactly once';
    END IF;
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER fiscal_outgoing_nfse_request_snapshot_immutable
    BEFORE UPDATE ON fiscal_outgoing_nfse_issuances
    FOR EACH ROW EXECUTE FUNCTION fiscal_outgoing_nfse_request_snapshot_immutable();

CREATE TABLE fiscal_outgoing_nfse_events (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    issuance_id uuid NOT NULL,
    event_type text NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 100),
    from_status text CHECK (from_status IS NULL OR from_status IN ('pending','processing','authorized','rejected','uncertain','cancelled')),
    to_status text NOT NULL CHECK (to_status IN ('pending','processing','authorized','rejected','uncertain','cancelled')),
    details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
    auth_subject text NOT NULL CHECK (char_length(auth_subject) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,issuance_id) REFERENCES fiscal_outgoing_nfse_issuances(tenant_id,id)
);

CREATE INDEX fiscal_outgoing_nfse_events_issuance_idx
    ON fiscal_outgoing_nfse_events(tenant_id,issuance_id,created_at,id);
CREATE TRIGGER fiscal_outgoing_nfse_events_append_only
    BEFORE UPDATE OR DELETE ON fiscal_outgoing_nfse_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();

ALTER TABLE fiscal_outgoing_nfse_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_outgoing_nfse_issuances FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_outgoing_nfse_issuances_isolation ON fiscal_outgoing_nfse_issuances
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE fiscal_outgoing_nfse_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_outgoing_nfse_events FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_outgoing_nfse_events_isolation ON fiscal_outgoing_nfse_events
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

ALTER TABLE fiscal_outgoing_nfse_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_outgoing_nfse_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_outgoing_nfse_sequences_isolation ON fiscal_outgoing_nfse_sequences
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

INSERT INTO permissions(code,description) VALUES
    ('fiscal.outgoing_nfse.read','Consultar NFS-e emitidas pela empresa'),
    ('fiscal.outgoing_nfse.issue','Emitir e reconciliar NFS-e da empresa'),
    ('fiscal.outgoing_nfse.cancel','Cancelar NFS-e autorizadas da empresa');
