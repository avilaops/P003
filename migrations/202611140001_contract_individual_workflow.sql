-- Personal signing is a separate aggregate. Existing provider completion never
-- acquires personal ICP validity retroactively.
ALTER TABLE commercial_contracts ADD COLUMN signature_policy text NOT NULL
    DEFAULT 'legacy_docuseal' CHECK (signature_policy IN ('legacy_docuseal','icp_each_participant'));
ALTER TABLE commercial_contracts ADD CONSTRAINT commercial_contract_signature_policy_parent
    UNIQUE (tenant_id,id,signature_policy);
CREATE FUNCTION preserve_commercial_signature_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.signature_policy IS DISTINCT FROM OLD.signature_policy THEN
        RAISE EXCEPTION 'Signature policy is immutable' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER commercial_contract_signature_policy_immutable BEFORE UPDATE ON commercial_contracts
    FOR EACH ROW EXECUTE FUNCTION preserve_commercial_signature_policy();

CREATE TABLE contract_signature_envelopes (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    contract_id uuid NOT NULL,
    policy text NOT NULL CHECK (policy='icp_each_participant'),
    policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
    trust_bundle_sha256 text NOT NULL CHECK (trust_bundle_sha256 ~ '^[0-9a-f]{64}$'),
    trust_profile text NOT NULL DEFAULT 'icp_brasil' CHECK (trust_profile='icp_brasil'),
    participant_count smallint NOT NULL CHECK (participant_count BETWEEN 1 AND 10),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    UNIQUE (tenant_id,contract_id),
    UNIQUE (tenant_id,id,policy_sha256,trust_bundle_sha256),
    FOREIGN KEY (tenant_id,contract_id,policy) REFERENCES commercial_contracts(tenant_id,id,signature_policy)
);
CREATE TABLE contract_signature_participants (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
    role text NOT NULL CHECK (char_length(btrim(role)) BETWEEN 1 AND 100),
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
    cpf_masked text NOT NULL CHECK (cpf_masked ~ '^\*\*\*\.\*\*\*\.\*\*\*-[0-9]{2}$'),
    identity_key_id text NOT NULL CHECK (identity_key_id ~ '^[a-zA-Z0-9_-]{1,40}$'),
    identity_nonce bytea NOT NULL CHECK (octet_length(identity_nonce)=12),
    identity_ciphertext bytea NOT NULL CHECK (octet_length(identity_ciphertext)=27),
    represented_cnpj text CHECK (represented_cnpj ~ '^[A-Z0-9]{12}[0-9]{2}$'),
    representation_reference text CHECK (char_length(btrim(representation_reference)) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,position),
    UNIQUE (tenant_id,envelope_id,id,position),
    FOREIGN KEY (tenant_id,envelope_id) REFERENCES contract_signature_envelopes(tenant_id,id)
);
CREATE TABLE contract_signature_states (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    phase text NOT NULL CHECK (phase IN ('portal_pending','preflight_pending','personal_signing','completed','blocked')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    current_participant smallint NOT NULL DEFAULT 1 CHECK (current_participant BETWEEN 1 AND 10),
    document_count smallint NOT NULL DEFAULT 0 CHECK (document_count BETWEEN 0 AND 10),
    documents_frozen_at timestamptz,
    stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes BETWEEN 0 AND 1073741824),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes BETWEEN 0 AND 1073741824),
    problem_code text CHECK (problem_code ~ '^[a-z][a-z0-9_]{0,79}$'),
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id),
    FOREIGN KEY (tenant_id,envelope_id) REFERENCES contract_signature_envelopes(tenant_id,id),
    CHECK (stored_bytes+reserved_bytes<=1073741824),
    CHECK ((document_count=0)=(documents_frozen_at IS NULL)),
    CHECK ((phase='completed')=(completed_at IS NOT NULL)),
    CHECK (phase IN ('portal_pending','blocked') OR document_count>0)
);
CREATE TABLE contract_signature_documents (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    position smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
    provider_document_id text NOT NULL CHECK (char_length(provider_document_id) BETWEEN 1 AND 200),
    filename text NOT NULL DEFAULT 'contrato.pdf' CHECK (char_length(filename) BETWEEN 1 AND 180),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 5 AND 20971520),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,position),
    UNIQUE (tenant_id,envelope_id,provider_document_id),
    UNIQUE (tenant_id,envelope_id,id,sha256),
    FOREIGN KEY (tenant_id,envelope_id) REFERENCES contract_signature_envelopes(tenant_id,id),
    CHECK (sha256=encode(sha256(content),'hex'))
);
-- Accepted proof is immutable; rejected uploads and their diagnostic bundles
-- belong to the expiring quarantine instead. No certificate private keys here.
CREATE TABLE contract_signature_evidence (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    participant_id uuid,
    mode text NOT NULL CHECK (mode IN ('preflight','increment')),
    verdict text NOT NULL CHECK (verdict='accepted'),
    parent_sha256 text NOT NULL CHECK (parent_sha256 ~ '^[0-9a-f]{64}$'),
    candidate_sha256 text NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
    policy_sha256 text NOT NULL,
    trust_bundle_sha256 text NOT NULL,
    evidence_set_sha256 text NOT NULL CHECK (evidence_set_sha256 ~ '^[0-9a-f]{64}$'),
    report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
    bundle_sha256 text NOT NULL CHECK (bundle_sha256 ~ '^[0-9a-f]{64}$'),
    response_headers jsonb NOT NULL CHECK (jsonb_typeof(response_headers)='object' AND octet_length(response_headers::text)<=4096),
    bundle bytea NOT NULL CHECK (octet_length(bundle) BETWEEN 16 AND 41943040),
    observed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,id,document_id,participant_id,parent_sha256,candidate_sha256,mode),
    UNIQUE (tenant_id,envelope_id,id,document_id,candidate_sha256,mode),
    FOREIGN KEY (tenant_id,envelope_id,document_id) REFERENCES contract_signature_documents(tenant_id,envelope_id,id),
    FOREIGN KEY (tenant_id,envelope_id,participant_id) REFERENCES contract_signature_participants(tenant_id,envelope_id,id),
    FOREIGN KEY (tenant_id,envelope_id,policy_sha256,trust_bundle_sha256) REFERENCES contract_signature_envelopes(tenant_id,id,policy_sha256,trust_bundle_sha256),
    CHECK ((mode='preflight')=(participant_id IS NULL)),
    CHECK ((mode='preflight' AND parent_sha256=candidate_sha256) OR (mode='increment' AND parent_sha256<>candidate_sha256)),
    CHECK (bundle_sha256=encode(sha256(bundle),'hex'))
);
CREATE TABLE contract_signature_revisions (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    document_id uuid NOT NULL,
    id uuid NOT NULL,
    sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 10),
    participant_id uuid NOT NULL,
    base_sha256 text NOT NULL,
    parent_sequence smallint,
    parent_sha256 text NOT NULL CHECK (parent_sha256 ~ '^[0-9a-f]{64}$'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 5 AND 33554432),
    evidence_id uuid NOT NULL,
    evidence_mode text NOT NULL DEFAULT 'increment' CHECK (evidence_mode='increment'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id,document_id,sequence),
    UNIQUE (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,document_id,sequence,sha256),
    UNIQUE (tenant_id,envelope_id,document_id,id,sequence,sha256),
    FOREIGN KEY (tenant_id,envelope_id,document_id,base_sha256) REFERENCES contract_signature_documents(tenant_id,envelope_id,id,sha256),
    FOREIGN KEY (tenant_id,envelope_id,participant_id,sequence) REFERENCES contract_signature_participants(tenant_id,envelope_id,id,position),
    FOREIGN KEY (tenant_id,envelope_id,document_id,parent_sequence,parent_sha256) REFERENCES contract_signature_revisions(tenant_id,envelope_id,document_id,sequence,sha256),
    FOREIGN KEY (tenant_id,envelope_id,evidence_id,document_id,participant_id,parent_sha256,sha256,evidence_mode) REFERENCES contract_signature_evidence(tenant_id,envelope_id,id,document_id,participant_id,parent_sha256,candidate_sha256,mode),
    CHECK ((sequence=1 AND parent_sequence IS NULL AND parent_sha256=base_sha256) OR (sequence>1 AND parent_sequence IS NOT NULL AND parent_sequence=sequence-1)),
    CHECK (sha256<>parent_sha256 AND sha256=encode(sha256(content),'hex'))
);
CREATE TABLE contract_signature_heads (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    document_id uuid NOT NULL,
    base_sha256 text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    sequence smallint NOT NULL DEFAULT 0 CHECK (sequence BETWEEN 0 AND 10),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    revision_id uuid,
    preflight_evidence_id uuid,
    preflight_mode text NOT NULL DEFAULT 'preflight' CHECK (preflight_mode='preflight'),
    PRIMARY KEY (tenant_id,envelope_id,document_id),
    FOREIGN KEY (tenant_id,envelope_id,document_id,base_sha256) REFERENCES contract_signature_documents(tenant_id,envelope_id,id,sha256),
    FOREIGN KEY (tenant_id,envelope_id,document_id,revision_id,sequence,sha256) REFERENCES contract_signature_revisions(tenant_id,envelope_id,document_id,id,sequence,sha256),
    FOREIGN KEY (tenant_id,envelope_id,preflight_evidence_id,document_id,base_sha256,preflight_mode) REFERENCES contract_signature_evidence(tenant_id,envelope_id,id,document_id,candidate_sha256,mode),
    CHECK ((sequence=0 AND revision_id IS NULL AND sha256=base_sha256) OR (sequence>0 AND revision_id IS NOT NULL AND preflight_evidence_id IS NOT NULL))
);
CREATE TABLE contract_signature_uploads (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    participant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    parent_sha256 text NOT NULL CHECK (parent_sha256 ~ '^[0-9a-f]{64}$'),
    expected_head_revision bigint NOT NULL CHECK (expected_head_revision>0),
    expected_stage_revision bigint NOT NULL CHECK (expected_stage_revision>0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content bytea NOT NULL CHECK (octet_length(content) BETWEEN 5 AND 33554432),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validating','accepted','rejected','expired')),
    quarantine_until timestamptz,
    problem_code text CHECK (problem_code ~ '^[a-z][a-z0-9_]{0,79}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,id,document_id),
    FOREIGN KEY (tenant_id,envelope_id,participant_id) REFERENCES contract_signature_participants(tenant_id,envelope_id,id),
    FOREIGN KEY (tenant_id,envelope_id,document_id) REFERENCES contract_signature_documents(tenant_id,envelope_id,id),
    CHECK (sha256=encode(sha256(content),'hex')),
    CHECK (status NOT IN ('rejected','expired') OR quarantine_until IS NOT NULL)
);
CREATE INDEX contract_signature_uploads_pending ON contract_signature_uploads(tenant_id,envelope_id,participant_id)
    WHERE status IN ('pending','validating');
CREATE INDEX contract_signature_uploads_quarantine ON contract_signature_uploads(quarantine_until)
    WHERE status IN ('rejected','expired');
CREATE TABLE contract_signature_jobs (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    document_id uuid NOT NULL,
    upload_id uuid,
    kind text NOT NULL CHECK (kind IN ('preflight','increment')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','completed','rejected')),
    lease_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,envelope_id,id),
    FOREIGN KEY (tenant_id,envelope_id,document_id) REFERENCES contract_signature_documents(tenant_id,envelope_id,id),
    FOREIGN KEY (tenant_id,envelope_id,upload_id,document_id) REFERENCES contract_signature_uploads(tenant_id,envelope_id,id,document_id),
    CHECK ((kind='preflight')=(upload_id IS NULL)),
    CHECK ((status='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
    CHECK ((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX contract_signature_jobs_preflight ON contract_signature_jobs(tenant_id,envelope_id,document_id) WHERE kind='preflight';
CREATE UNIQUE INDEX contract_signature_jobs_increment ON contract_signature_jobs(tenant_id,envelope_id,upload_id) WHERE kind='increment';
CREATE INDEX contract_signature_jobs_claim ON contract_signature_jobs(tenant_id,available_at,lease_until,id) WHERE status IN ('pending','leased');
CREATE TABLE contract_signature_grants (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    participant_id uuid NOT NULL,
    token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    portal_assertion_sha256 text NOT NULL CHECK (portal_assertion_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    PRIMARY KEY (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,id,participant_id),
    FOREIGN KEY (tenant_id,envelope_id,participant_id) REFERENCES contract_signature_participants(tenant_id,envelope_id,id),
    CHECK (expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
    CHECK (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at))
);
CREATE TABLE contract_signature_sessions (
    tenant_id uuid NOT NULL,
    envelope_id uuid NOT NULL,
    id uuid NOT NULL,
    participant_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    PRIMARY KEY (tenant_id,envelope_id,id),
    UNIQUE (tenant_id,envelope_id,grant_id),
    FOREIGN KEY (tenant_id,envelope_id,grant_id,participant_id) REFERENCES contract_signature_grants(tenant_id,envelope_id,id,participant_id),
    CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour')
);

DO $$
DECLARE item text;
BEGIN
    FOREACH item IN ARRAY ARRAY['contract_signature_envelopes','contract_signature_participants',
        'contract_signature_states','contract_signature_documents','contract_signature_revisions',
        'contract_signature_heads','contract_signature_evidence','contract_signature_uploads',
        'contract_signature_jobs','contract_signature_grants','contract_signature_sessions']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',item);
        EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',item);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT ON %I TO erp_next_app',item);
        END IF;
    END LOOP;
    FOREACH item IN ARRAY ARRAY['contract_signature_envelopes','contract_signature_participants',
        'contract_signature_documents','contract_signature_revisions','contract_signature_evidence']
    LOOP
        EXECUTE format('CREATE TRIGGER signature_snapshot_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes()',item);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT UPDATE ON contract_signature_states,contract_signature_heads,contract_signature_uploads,
            contract_signature_jobs,contract_signature_grants,contract_signature_sessions TO erp_next_app;
        GRANT DELETE ON contract_signature_uploads TO erp_next_app;
    END IF;
END $$;
