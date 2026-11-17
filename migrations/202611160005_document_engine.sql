CREATE SCHEMA document_engine;
REVOKE ALL ON SCHEMA document_engine FROM PUBLIC;

CREATE TABLE document_engine.document_templates (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    document_type text NOT NULL CHECK (document_type IN ('order','proposal','invoice','payment_proof','contract','additional')),
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id,id), UNIQUE (tenant_id,document_type,name)
);

CREATE TABLE document_engine.document_template_versions (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, template_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    engine text NOT NULL CHECK (engine IN ('typst','weasyprint','pandoc')),
    content text NOT NULL CHECK (char_length(content) > 0),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
    UNIQUE (tenant_id,id), UNIQUE (tenant_id,template_id,version),
    FOREIGN KEY (tenant_id,template_id) REFERENCES document_engine.document_templates(tenant_id,id)
);

CREATE TABLE document_engine.render_jobs (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    template_version_id uuid NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('order','proposal','invoice','receivable','contract','manual')),
    source_id uuid NOT NULL, source_revision bigint NOT NULL CHECK (source_revision > 0),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 180),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','succeeded','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
    leased_by text, safe_error text, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id,id), UNIQUE (tenant_id,idempotency_key),
    FOREIGN KEY (tenant_id,template_version_id) REFERENCES document_engine.document_template_versions(tenant_id,id),
    CHECK ((status='leased') = (lease_until IS NOT NULL AND leased_by IS NOT NULL))
);

CREATE TABLE document_engine.rendered_documents (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    render_job_id uuid NOT NULL, template_version_id uuid NOT NULL,
    document_type text NOT NULL CHECK (document_type IN ('order','proposal','invoice','payment_proof','contract','additional')),
    source_kind text NOT NULL, source_id uuid NOT NULL,
    source_revision bigint NOT NULL CHECK (source_revision > 0),
    storage_key text NOT NULL CHECK (char_length(storage_key) BETWEEN 1 AND 500),
    media_type text NOT NULL CHECK (media_type IN ('application/pdf','text/html','text/plain')),
    byte_size bigint NOT NULL CHECK (byte_size > 0),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
    rendered_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id,id), UNIQUE (tenant_id,render_job_id), UNIQUE (tenant_id,storage_key),
    FOREIGN KEY (tenant_id,render_job_id) REFERENCES document_engine.render_jobs(tenant_id,id),
    FOREIGN KEY (tenant_id,template_version_id) REFERENCES document_engine.document_template_versions(tenant_id,id)
);

CREATE TABLE document_engine.document_packets (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    order_id uuid, contract_id uuid,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sealed')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), sealed_at timestamptz,
    UNIQUE (tenant_id,id),
    FOREIGN KEY (tenant_id,order_id) REFERENCES sales_orders(tenant_id,id),
    FOREIGN KEY (tenant_id,contract_id) REFERENCES commercial_contracts(tenant_id,id),
    CHECK (order_id IS NOT NULL OR contract_id IS NOT NULL),
    CHECK ((status='sealed') = (sealed_at IS NOT NULL))
);

CREATE TABLE document_engine.document_packet_items (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, packet_id uuid NOT NULL,
    document_id uuid NOT NULL,
    section text NOT NULL CHECK (section IN ('order','invoice','payment_proof','contract','additional')),
    position integer NOT NULL CHECK (position > 0),
    added_by text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id,id), UNIQUE (tenant_id,packet_id,position),
    UNIQUE (tenant_id,packet_id,document_id),
    FOREIGN KEY (tenant_id,packet_id) REFERENCES document_engine.document_packets(tenant_id,id),
    FOREIGN KEY (tenant_id,document_id) REFERENCES document_engine.rendered_documents(tenant_id,id)
);

CREATE INDEX document_templates_list_idx ON document_engine.document_templates
    (tenant_id,document_type,status,updated_at DESC,id DESC);
CREATE INDEX render_jobs_claim_idx ON document_engine.render_jobs
    (tenant_id,available_at,lease_until,id) WHERE status IN ('pending','leased');
CREATE INDEX rendered_documents_source_idx ON document_engine.rendered_documents
    (tenant_id,source_kind,source_id,source_revision DESC);
CREATE INDEX document_packets_order_idx ON document_engine.document_packets
    (tenant_id,order_id,updated_at DESC,id DESC);
CREATE INDEX document_packets_contract_idx ON document_engine.document_packets
    (tenant_id,contract_id,updated_at DESC,id DESC);

CREATE FUNCTION document_engine.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Document evidence is immutable' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER document_template_versions_immutable BEFORE UPDATE OR DELETE
    ON document_engine.document_template_versions FOR EACH ROW
    EXECUTE FUNCTION document_engine.reject_immutable_change();
CREATE TRIGGER rendered_documents_immutable BEFORE UPDATE OR DELETE
    ON document_engine.rendered_documents FOR EACH ROW
    EXECUTE FUNCTION document_engine.reject_immutable_change();

CREATE FUNCTION document_engine.guard_packet_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.status='sealed' THEN
        RAISE EXCEPTION 'Sealed document packet is immutable' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER document_packets_sealed_immutable BEFORE UPDATE OR DELETE
    ON document_engine.document_packets FOR EACH ROW
    EXECUTE FUNCTION document_engine.guard_packet_change();

CREATE FUNCTION document_engine.guard_packet_item_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE packet_status text; target_tenant uuid; target_packet uuid;
BEGIN
    IF TG_OP='DELETE' THEN
        target_tenant := OLD.tenant_id; target_packet := OLD.packet_id;
    ELSE
        target_tenant := NEW.tenant_id; target_packet := NEW.packet_id;
    END IF;
    SELECT status INTO packet_status FROM document_engine.document_packets
      WHERE tenant_id=target_tenant AND id=target_packet;
    IF packet_status IS DISTINCT FROM 'draft' THEN
        RAISE EXCEPTION 'Sealed or missing document packet cannot be changed' USING ERRCODE='42501';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER document_packet_items_draft_only BEFORE INSERT OR UPDATE OR DELETE
    ON document_engine.document_packet_items FOR EACH ROW
    EXECUTE FUNCTION document_engine.guard_packet_item_change();

DO $policies$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['document_templates','document_template_versions','render_jobs','rendered_documents','document_packets','document_packet_items'] LOOP
        EXECUTE format('ALTER TABLE document_engine.%I ENABLE ROW LEVEL SECURITY',table_name);
        EXECUTE format('ALTER TABLE document_engine.%I FORCE ROW LEVEL SECURITY',table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON document_engine.%I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
        EXECUTE format('REVOKE ALL ON document_engine.%I FROM PUBLIC',table_name);
    END LOOP;
END
$policies$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT USAGE ON SCHEMA document_engine TO erp_next_app;
        GRANT SELECT,INSERT,UPDATE ON document_engine.document_templates,
          document_engine.render_jobs,document_engine.document_packets,
          document_engine.document_packet_items TO erp_next_app;
        GRANT SELECT,INSERT ON document_engine.document_template_versions,
          document_engine.rendered_documents TO erp_next_app;
    END IF;
END $$;
