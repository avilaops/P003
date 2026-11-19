-- Motor de relatórios (G3): definição com agrupamento/totais, agenda por e-mail e histórico de execução.
-- A permissão exigida pela fonte é gravada na definição pela API (registro de fontes em TypeScript).
-- Assim uma fonte nova não exige migração da política nem da restrição de `dataset`.

ALTER TABLE system_config.report_definitions DROP CONSTRAINT report_definitions_dataset_check,
    ADD CONSTRAINT report_definitions_dataset_format CHECK (dataset ~ '^[a-z][a-z0-9_]{0,62}$'),
    ADD COLUMN group_by jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(group_by) = 'array' AND jsonb_array_length(group_by) <= 2),
    ADD COLUMN totals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(totals) = 'array' AND jsonb_array_length(totals) <= 20),
    ADD COLUMN required_permissions text[] NOT NULL DEFAULT '{}';

UPDATE system_config.report_definitions SET required_permissions = CASE
    WHEN dataset = 'products' THEN ARRAY['catalog.products.read']
    WHEN dataset = 'parties' THEN ARRAY['catalog.parties.read']
    WHEN dataset = 'sales_orders' THEN ARRAY['sales.orders.read']
    WHEN dataset = 'audit_log' THEN ARRAY['platform.audit.read']
    WHEN dataset IN ('stock_divergences','stock_accuracy','stock_count_progress') THEN ARRAY['inventory.stock.read','inventory.counts.read']
    WHEN dataset = 'stock_production_progress' THEN ARRAY['inventory.stock.read','production.read']
    ELSE ARRAY['inventory.stock.read'] END;

ALTER TABLE system_config.report_definitions
    ADD CONSTRAINT report_definitions_permissions_present CHECK (cardinality(required_permissions) BETWEEN 1 AND 5);

ALTER POLICY report_reader_authorization ON system_config.report_definitions USING (
    system_config.has_permission('system.reports.read')
    AND NOT EXISTS (SELECT 1 FROM unnest(required_permissions) AS needed(code) WHERE NOT system_config.has_permission(needed.code))
    AND (visibility='tenant' OR EXISTS (SELECT 1 FROM public.identities i WHERE i.id=owner_identity_id
        AND i.auth_subject=nullif(current_setting('app.auth_subject',true),'')))
);

CREATE TABLE report_schedules (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    definition_id uuid NOT NULL,
    owner_identity_id uuid NOT NULL,
    frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
    weekday smallint CHECK (weekday BETWEEN 0 AND 6),
    month_day smallint CHECK (month_day BETWEEN 1 AND 28),
    hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
    format text NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
    recipients text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 20),
    active boolean NOT NULL DEFAULT true,
    next_run_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
    CHECK ((frequency = 'monthly') = (month_day IS NOT NULL)),
    FOREIGN KEY (tenant_id, definition_id) REFERENCES system_config.report_definitions(tenant_id, id),
    FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES tenant_memberships(tenant_id, identity_id)
);
CREATE INDEX report_schedules_due ON report_schedules(next_run_at) WHERE active;
CREATE INDEX report_schedules_definition ON report_schedules(tenant_id, definition_id);

-- Uma linha por ocorrência: a chave única torna a execução idempotente (o job pode reiniciar).
CREATE TABLE report_runs (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    scheduled_for timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('sending','sent','failed','unknown')),
    format text NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
    recipients text[] NOT NULL,
    row_count integer CHECK (row_count >= 0),
    file_name text,
    content_type text,
    content bytea CHECK (octet_length(content) <= 10485760),
    error text CHECK (char_length(error) <= 500),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, schedule_id, scheduled_for),
    FOREIGN KEY (tenant_id, schedule_id) REFERENCES report_schedules(tenant_id, id)
);
CREATE INDEX report_runs_schedule ON report_runs(tenant_id, schedule_id, scheduled_for DESC);

ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON report_schedules
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.discover_report_schedules', true) = 'on')
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON report_runs
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- A agenda e o histórico seguem a visibilidade da definição (permissão da fonte e privacidade).
CREATE POLICY schedule_reader_authorization ON report_schedules AS RESTRICTIVE FOR SELECT USING (
    current_setting('app.discover_report_schedules', true) = 'on'
    OR EXISTS (SELECT 1 FROM system_config.report_definitions d WHERE d.tenant_id=report_schedules.tenant_id AND d.id=report_schedules.definition_id));
CREATE POLICY run_reader_authorization ON report_runs AS RESTRICTIVE FOR SELECT USING (
    current_setting('app.discover_report_schedules', true) = 'on'
    OR EXISTS (SELECT 1 FROM system_config.report_definitions d WHERE d.tenant_id=report_runs.tenant_id AND d.id=report_runs.definition_id));

-- Descoberta entre empresas para o job: devolve só a ocorrência devida e quem a executa.
CREATE FUNCTION report_due_schedules(due_before timestamptz) RETURNS TABLE(tenant_id uuid, schedule_id uuid, auth_subject text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=coalesce(current_setting('app.discover_report_schedules',true),'');
BEGIN
    PERFORM set_config('app.discover_report_schedules','on',true);
    RETURN QUERY SELECT s.tenant_id, s.id, i.auth_subject FROM public.report_schedules s
        JOIN public.identities i ON i.id=s.owner_identity_id
        WHERE s.active AND s.next_run_at <= due_before ORDER BY s.next_run_at LIMIT 100;
    PERFORM set_config('app.discover_report_schedules',previous,true);
END $$;
REVOKE ALL ON FUNCTION report_due_schedules(timestamptz) FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT EXECUTE ON FUNCTION report_due_schedules(timestamptz) TO erp_next_app;
        GRANT SELECT, INSERT, UPDATE ON report_schedules, report_runs TO erp_next_app;
    END IF;
END $$;
