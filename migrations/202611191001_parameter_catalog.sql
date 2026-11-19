-- G5 • Catálogo único de parâmetros (padrão MV_* do Protheus).
-- As definições são globais e só nascem por migração: toda funcionalidade nova
-- registra aqui os seus parâmetros (código, módulo, tipo, padrão e efeito).
-- O valor por empresa fica em `parameter_values`; NULL volta ao padrão.
CREATE TABLE parameter_definitions (
    code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length(code) <= 120),
    module text NOT NULL CHECK (module IN ('platform','preferences','registrations','sales','inventory','purchasing','finance','fiscal','period_close','data')),
    label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
    description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 600),
    value_type text NOT NULL CHECK (value_type IN ('boolean','integer','decimal','text','choice')),
    default_value jsonb NOT NULL CHECK (default_value <> 'null'::jsonb),
    choices jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(choices) = 'array'),
    minimum numeric,
    maximum numeric,
    unit text CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 20),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((value_type = 'choice') = (jsonb_array_length(choices) > 0)),
    CHECK (minimum IS NULL OR maximum IS NULL OR minimum <= maximum)
);

CREATE TABLE parameter_values (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL REFERENCES parameter_definitions(code),
    value jsonb CHECK (value IS NULL OR value <> 'null'::jsonb),
    revision bigint NOT NULL DEFAULT 2 CHECK (revision > 1),
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, code)
);
ALTER TABLE parameter_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE parameter_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parameter_values
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_next_app') THEN
    GRANT SELECT ON parameter_definitions TO erp_next_app;
    GRANT SELECT, INSERT, UPDATE ON parameter_values TO erp_next_app;
  END IF;
END $$;

INSERT INTO permissions(code, description) VALUES
    ('system.parameters.read', 'Consultar o catálogo de parâmetros da empresa'),
    ('system.parameters.manage', 'Alterar parâmetros da empresa')
ON CONFLICT (code) DO NOTHING;

-- Parâmetros das funcionalidades da plataforma (G6, G8, G10). Os demais módulos
-- acrescentam os seus em migrações próprias, com o mesmo INSERT.
INSERT INTO parameter_definitions(code, module, label, description, value_type, default_value, choices, minimum, maximum, unit) VALUES
    ('platform.plan.warning_percent', 'platform', 'Aviso de limite do plano',
     'Percentual de consumo de um limite do plano a partir do qual o ERP avisa a empresa. Ao atingir 100%, novos cadastros daquele recurso são bloqueados até a troca de plano; consultas continuam liberadas.',
     'integer', '80', '[]', 50, 99, '%'),
    ('period_close.reopen_requires_reason', 'period_close', 'Exigir motivo na reabertura',
     'Quando ligado, reabrir um período fechado exige motivo com ao menos 10 caracteres, registrado na auditoria.',
     'boolean', 'true', '[]', NULL, NULL, NULL),
    ('period_close.reminder_day', 'period_close', 'Dia sugerido para fechar o mês',
     'Dia do mês seguinte a partir do qual o painel de fechamento destaca o mês anterior como pendente.',
     'integer', '5', '[]', 1, 28, 'dia'),
    ('data.export.retention_days', 'data', 'Retenção das exportações',
     'Quantidade de dias em que o arquivo de uma exportação integral fica disponível para download. Depois disso, o arquivo é descartado e a exportação aparece como expirada.',
     'integer', '7', '[]', 1, 30, 'dias'),
    ('data.export.schedule', 'data', 'Exportação integral agendada',
     'Frequência da exportação integral automática dos dados da empresa. Desligada, a exportação só acontece sob demanda.',
     'choice', '"off"', '["off","weekly","monthly"]', NULL, NULL, NULL)
ON CONFLICT (code) DO NOTHING;

-- Administradores existentes recebem as novas permissões pelo editor de papéis normal.
DO $migration$
DECLARE company uuid; previous_tenant text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY parameter_permission_migration_scan ON tenants FOR SELECT TO %I USING(true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        WITH assigned AS (
            INSERT INTO role_permissions(role_id,permission_code)
            SELECT r.id,p.code FROM roles r CROSS JOIN permissions p
            WHERE r.tenant_id=company AND r.code IN ('admin','administrator')
              AND p.code IN ('system.parameters.read','system.parameters.manage')
            ON CONFLICT DO NOTHING RETURNING role_id
        )
        UPDATE roles SET revision=revision+1 WHERE tenant_id=company AND id IN (SELECT role_id FROM assigned);
    END LOOP;
    PERFORM set_config('app.tenant_id',previous_tenant,true);
    DROP POLICY parameter_permission_migration_scan ON tenants;
END $migration$;
