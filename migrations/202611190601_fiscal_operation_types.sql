-- F1 • Tipos de operação (equivalente ao TES).
-- Um cadastro concentra CFOP, tributos e efeitos operacionais (estoque, financeiro, comissão).
-- O ERP não completa regras ausentes: colunas vazias tornam o tipo incompleto e a transmissão é bloqueada.
CREATE TABLE fiscal_operation_types (
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    id uuid NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    direction text NOT NULL CHECK (direction IN ('incoming','outgoing')),
    purpose text NOT NULL CHECK (purpose IN ('sale_own_production','resale','repair_shipment','return','bonus','other')),
    nfe_purpose smallint NOT NULL DEFAULT 1 CHECK (nfe_purpose BETWEEN 1 AND 4),
    cfop_internal text CHECK (cfop_internal ~ '^\d{4}$'),
    cfop_interstate text CHECK (cfop_interstate ~ '^\d{4}$'),
    cfop_foreign text CHECK (cfop_foreign ~ '^\d{4}$'),
    icms_cst text CHECK (icms_cst ~ '^\d{2}$'),
    icms_csosn text CHECK (icms_csosn ~ '^\d{3}$'),
    ipi_cst text CHECK (ipi_cst ~ '^\d{2}$'),
    pis_cst text CHECK (pis_cst ~ '^\d{2}$'),
    cofins_cst text CHECK (cofins_cst ~ '^\d{2}$'),
    ibs_cbs_cst text CHECK (ibs_cbs_cst ~ '^\d{3}$'),
    ibs_cbs_class text CHECK (ibs_cbs_class ~ '^\d{6}$'),
    moves_stock boolean NOT NULL,
    generates_finance boolean NOT NULL,
    generates_commission boolean NOT NULL,
    requires_origin boolean NOT NULL,
    financial_category_id uuid,
    is_default boolean NOT NULL DEFAULT false,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, code),
    FOREIGN KEY (tenant_id, financial_category_id) REFERENCES financial_categories(tenant_id, id),
    -- CFOP: 1/2/3 para entradas, 5/6/7 para saídas, na ordem dentro do estado, fora do estado, exterior.
    CHECK (cfop_internal IS NULL OR left(cfop_internal,1) = CASE direction WHEN 'incoming' THEN '1' ELSE '5' END),
    CHECK (cfop_interstate IS NULL OR left(cfop_interstate,1) = CASE direction WHEN 'incoming' THEN '2' ELSE '6' END),
    CHECK (cfop_foreign IS NULL OR left(cfop_foreign,1) = CASE direction WHEN 'incoming' THEN '3' ELSE '7' END),
    CHECK (NOT generates_commission OR generates_finance),
    CHECK (purpose <> 'return' OR (requires_origin AND nfe_purpose = 4))
);
-- Um único padrão ativo por finalidade e sentido.
CREATE UNIQUE INDEX fiscal_operation_types_default ON fiscal_operation_types(tenant_id, direction, purpose) WHERE is_default AND active;

ALTER TABLE sales_orders ADD COLUMN operation_type_id uuid;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_operation_type_fk
    FOREIGN KEY (tenant_id, operation_type_id) REFERENCES fiscal_operation_types(tenant_id, id);

ALTER TABLE fiscal_operation_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_operation_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_operation_types
    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO permissions(code,description) VALUES
    ('fiscal.operation_types.read','Consultar tipos de operação fiscal'),
    ('fiscal.operation_types.manage','Cadastrar e alterar tipos de operação fiscal'),
    ('fiscal.operation_types.override','Alterar manualmente o tipo de operação de pedidos e notas')
ON CONFLICT DO NOTHING;
DO $$ DECLARE company uuid; previous text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY operation_types_migration_scan ON tenants FOR SELECT TO %I USING(true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        INSERT INTO role_permissions(role_id,permission_code)
        SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.tenant_id=company AND r.code IN ('admin','administrator') AND p.code LIKE 'fiscal.operation_types.%' ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM set_config('app.tenant_id',previous,true);
    DROP POLICY operation_types_migration_scan ON tenants;
END $$;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON fiscal_operation_types TO erp_next_app;
    END IF;
END $$;
