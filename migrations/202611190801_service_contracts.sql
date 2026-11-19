-- S1 • Contratos de serviço com faturamento recorrente.
-- Cabeçalho do contrato, versões imutáveis (original, aditivo e reajuste) e o
-- cronograma de faturamento. Um período só pode ser faturado uma vez:
-- UNIQUE(tenant_id, contract_id, period_start) torna o job idempotente.
CREATE TABLE service_contracts (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    number text NOT NULL CHECK (number ~ '^CTS-[0-9]{6,}$'),
    customer_id uuid NOT NULL,
    title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 160),
    periodicity text NOT NULL CHECK (periodicity IN ('monthly','quarterly','semiannual','annual')),
    billing_day smallint NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
    due_days smallint NOT NULL CHECK (due_days BETWEEN 0 AND 120),
    start_on date NOT NULL,
    end_on date NOT NULL,
    adjustment_index text NOT NULL CHECK (adjustment_index IN ('none','ipca','igpm','inpc','fixed')),
    adjustment_base_on date NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','suspended','closed','cancelled')),
    current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, number),
    CHECK (end_on > start_on),
    FOREIGN KEY (tenant_id, customer_id) REFERENCES parties(tenant_id, id)
);
CREATE INDEX service_contracts_status_end ON service_contracts(tenant_id, status, end_on);

CREATE TABLE service_contract_versions (
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    kind text NOT NULL CHECK (kind IN ('original','amendment','adjustment')),
    effective_from date NOT NULL,
    end_on date NOT NULL,
    items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 50),
    amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999999),
    adjustment_cycle integer CHECK (adjustment_cycle > 0),
    adjustment_rate_bp integer CHECK (adjustment_rate_bp BETWEEN -9999 AND 100000),
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 500),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, contract_id, version),
    UNIQUE (tenant_id, contract_id, adjustment_cycle),
    CHECK ((kind = 'adjustment') = (adjustment_cycle IS NOT NULL)),
    CHECK ((adjustment_cycle IS NULL) = (adjustment_rate_bp IS NULL)),
    FOREIGN KEY (tenant_id, contract_id) REFERENCES service_contracts(tenant_id, id)
);
CREATE TRIGGER service_contract_versions_immutable BEFORE UPDATE OR DELETE ON service_contract_versions
    FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes();

CREATE TABLE service_contract_billings (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    issue_on date NOT NULL,
    due_on date NOT NULL,
    version integer,
    amount_cents bigint CHECK (amount_cents BETWEEN 1 AND 99999999999999),
    status text NOT NULL CHECK (status IN ('pending','issued','blocked','skipped')),
    invoice_ref text CHECK (invoice_ref IS NULL OR length(invoice_ref) BETWEEN 1 AND 200),
    receivable_ref text CHECK (receivable_ref IS NULL OR length(receivable_ref) BETWEEN 1 AND 200),
    message text CHECK (message IS NULL OR length(message) <= 500),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, contract_id, period_start),
    CHECK (period_end >= period_start AND due_on >= issue_on),
    CHECK (status <> 'issued' OR (invoice_ref IS NOT NULL AND receivable_ref IS NOT NULL AND version IS NOT NULL AND amount_cents IS NOT NULL)),
    FOREIGN KEY (tenant_id, contract_id) REFERENCES service_contracts(tenant_id, id),
    FOREIGN KEY (tenant_id, contract_id, version) REFERENCES service_contract_versions(tenant_id, contract_id, version)
);
CREATE INDEX service_contract_billings_open ON service_contract_billings(tenant_id, status, issue_on) WHERE status IN ('pending','blocked');

DO $$
DECLARE item text;
BEGIN
    FOREACH item IN ARRAY ARRAY['service_contracts','service_contract_versions','service_contract_billings'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', item);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', item);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', item);
        -- Descoberta do job: só o dono da função abaixo enxerga, e só com a flag ligada.
        EXECUTE format('CREATE POLICY service_billing_discovery ON %I FOR SELECT TO %I USING (current_setting(''app.service_billing_discovery'',true)=''on'')', item, current_user);
    END LOOP;
END $$;

-- Descoberta estreita para o job: devolve apenas empresas com faturamento a gerar
-- ou a repetir até a data informada. Não expõe dados pessoais nem altera nada.
CREATE FUNCTION erp_service_billing_due_tenants(until date) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_flag text := coalesce(current_setting('app.service_billing_discovery',true),'');
BEGIN
    PERFORM set_config('app.service_billing_discovery','on',true);
    RETURN QUERY
        SELECT c.tenant_id FROM public.service_contracts c
         WHERE c.status = 'active' AND c.start_on <= until
        UNION
        SELECT b.tenant_id FROM public.service_contract_billings b
         WHERE b.status IN ('pending','blocked') AND b.issue_on <= until;
    PERFORM set_config('app.service_billing_discovery',previous_flag,true);
END
$$;
REVOKE ALL ON FUNCTION erp_service_billing_due_tenants(date) FROM PUBLIC;

INSERT INTO permissions(code, description) VALUES
    ('service.contracts.read', 'Consultar contratos de serviço, aditivos e faturamento recorrente'),
    ('service.contracts.manage', 'Cadastrar contratos de serviço, aditivos, reajustes e executar o faturamento')
ON CONFLICT(code) DO NOTHING;

DO $$ BEGIN
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON service_contracts,service_contract_billings TO erp_next_app;
        GRANT SELECT,INSERT ON service_contract_versions TO erp_next_app;
        GRANT EXECUTE ON FUNCTION erp_service_billing_due_tenants(date) TO erp_next_app;
    END IF;
END $$;
