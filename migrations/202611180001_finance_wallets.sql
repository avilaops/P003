CREATE TABLE financial_cost_centers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (tenant_id,id), UNIQUE (tenant_id,code)
);
CREATE TABLE financial_wallet_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    sales_category_id uuid,
    purchases_category_id uuid,
    payroll_category_id uuid,
    default_cost_center_id uuid,
    require_cost_center boolean NOT NULL DEFAULT false,
    interest_monthly_bps integer NOT NULL DEFAULT 0 CHECK (interest_monthly_bps BETWEEN 0 AND 10000),
    penalty_bps integer NOT NULL DEFAULT 0 CHECK (penalty_bps BETWEEN 0 AND 10000),
    grace_days integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 365),
    discount_limit_bps integer NOT NULL DEFAULT 10000 CHECK (discount_limit_bps BETWEEN 0 AND 10000),
    CHECK (NOT require_cost_center OR default_cost_center_id IS NOT NULL),
    FOREIGN KEY (tenant_id,sales_category_id) REFERENCES financial_categories(tenant_id,id),
    FOREIGN KEY (tenant_id,purchases_category_id) REFERENCES financial_categories(tenant_id,id),
    FOREIGN KEY (tenant_id,payroll_category_id) REFERENCES financial_categories(tenant_id,id),
    FOREIGN KEY (tenant_id,default_cost_center_id) REFERENCES financial_cost_centers(tenant_id,id)
);
INSERT INTO permissions(code,description) VALUES ('finance.discounts.approve','Autorizar descontos acima do limite da empresa')
ON CONFLICT DO NOTHING;

DO $$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['financial_cost_centers','financial_wallet_settings'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
            EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_next_app',t);
        END IF;
    END LOOP;
    FOREACH t IN ARRAY ARRAY['receivables','payables','receivable_payments','payable_payments'] LOOP
        EXECUTE format('ALTER TABLE %I ADD category_id uuid, ADD cost_center_id uuid,
            ADD FOREIGN KEY (tenant_id,category_id) REFERENCES financial_categories(tenant_id,id),
            ADD FOREIGN KEY (tenant_id,cost_center_id) REFERENCES financial_cost_centers(tenant_id,id)',t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['receivables','payables'] LOOP
        EXECUTE format('ALTER TABLE %I ADD competence_on date, ADD forecast_account_id uuid, ADD FOREIGN KEY (tenant_id,forecast_account_id) REFERENCES financial_accounts(tenant_id,id)',t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['receivable_payments','payable_payments'] LOOP
        EXECUTE format('ALTER TABLE %I
            ADD proof_metadata jsonb,
            ADD proof_content bytea,
            ADD CHECK ((proof_metadata IS NULL)=(proof_content IS NULL)),
            ADD CHECK (proof_content IS NULL OR (kind<>''reversal'' AND jsonb_typeof(proof_metadata)=''object'' AND octet_length(proof_content) BETWEEN 1 AND 10485760)),
            ADD interest_cents bigint NOT NULL DEFAULT 0 CHECK (interest_cents BETWEEN 0 AND 99999999999999),
            ADD penalty_cents bigint NOT NULL DEFAULT 0 CHECK (penalty_cents BETWEEN 0 AND 99999999999999),
            ADD surcharge_cents bigint NOT NULL DEFAULT 0 CHECK (surcharge_cents BETWEEN 0 AND 99999999999999),
            ADD discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents BETWEEN 0 AND 99999999999999),
            ADD financial_effect text CHECK (financial_effect IN (''cash'',''non_cash'')),
            ADD account_entry_id uuid,
            ADD FOREIGN KEY (tenant_id,account_entry_id) REFERENCES financial_account_entries(tenant_id,id),
            ADD UNIQUE (tenant_id,account_entry_id),
            ADD recorded_by text REFERENCES identities(auth_subject),
            ADD discount_approved_by text REFERENCES identities(auth_subject),
            ADD net_cents bigint GENERATED ALWAYS AS (amount_cents+interest_cents+penalty_cents+surcharge_cents-discount_cents) STORED,
            ADD CHECK (amount_cents+interest_cents+penalty_cents+surcharge_cents-discount_cents BETWEEN 0 AND 99999999999999),
            ADD CHECK (financial_effect IS NULL OR
               (financial_effect=''cash'' AND financial_account_id IS NOT NULL AND account_entry_id IS NOT NULL) OR
               (financial_effect=''non_cash'' AND financial_account_id IS NULL AND account_entry_id IS NULL))',t);
    END LOOP;
END $$;
ALTER TABLE financial_account_entries ADD cost_center_id uuid,
    ADD FOREIGN KEY (tenant_id,cost_center_id) REFERENCES financial_cost_centers(tenant_id,id);

-- Provision an origin's default nature lazily, including for companies created after migration.
CREATE FUNCTION finance_default_category(company uuid, origin text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE selected uuid; default_code text; default_name text; expected_direction text;
BEGIN
    SELECT CASE origin WHEN 'sale' THEN sales_category_id WHEN 'payroll' THEN payroll_category_id ELSE purchases_category_id END
      INTO selected FROM financial_wallet_settings WHERE tenant_id=company;
    expected_direction := CASE origin WHEN 'sale' THEN 'income' ELSE 'expense' END;
    IF selected IS NULL THEN
        default_code := CASE origin WHEN 'sale' THEN 'ERP.VENDAS' WHEN 'payroll' THEN 'ERP.PESSOAL' ELSE 'ERP.FORNECEDORES' END;
        default_name := CASE origin WHEN 'sale' THEN 'Receita de vendas' WHEN 'payroll' THEN 'Despesas de pessoal' ELSE 'Fornecedores' END;
        SELECT id INTO selected FROM financial_categories WHERE tenant_id=company AND code=default_code;
        IF selected IS NULL THEN
            INSERT INTO financial_categories(id,tenant_id,code,name,status,revision,direction)
              VALUES(gen_random_uuid(),company,default_code,default_name,'active',1,expected_direction)
              ON CONFLICT (tenant_id,code) DO NOTHING;
            SELECT id INTO selected FROM financial_categories WHERE tenant_id=company AND code=default_code;
        END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM financial_categories WHERE tenant_id=company AND id=selected AND status='active' AND direction=expected_direction) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Configure uma natureza ativa para a origem financeira';
    END IF;
    RETURN selected;
END $$;
CREATE FUNCTION finance_classify_title() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin text; defaults financial_wallet_settings%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME='receivables' THEN origin:='sale';
    ELSIF NEW.staff_obligation_id IS NOT NULL THEN origin:='payroll'; ELSE origin:='purchase'; END IF;
    NEW.category_id:=coalesce(NEW.category_id,finance_default_category(NEW.tenant_id,origin));
    SELECT * INTO defaults FROM financial_wallet_settings WHERE tenant_id=NEW.tenant_id;
    NEW.cost_center_id:=coalesce(NEW.cost_center_id,defaults.default_cost_center_id);
    IF NEW.cost_center_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM financial_cost_centers WHERE tenant_id=NEW.tenant_id AND id=NEW.cost_center_id AND status='active') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Configure um centro de custo ativo';
    END IF;
    NEW.competence_on:=coalesce(NEW.competence_on,(NEW.created_at AT TIME ZONE 'America/Sao_Paulo')::date);
    RETURN NEW;
END $$;
CREATE TRIGGER finance_classify_receivable BEFORE INSERT ON receivables FOR EACH ROW EXECUTE FUNCTION finance_classify_title();
CREATE TRIGGER finance_classify_payable BEFORE INSERT ON payables FOR EACH ROW EXECUTE FUNCTION finance_classify_title();

ALTER TABLE financial_wallet_settings ADD restructure_approval_limit_cents bigint CHECK (restructure_approval_limit_cents BETWEEN 0 AND 99999999999999);
ALTER TABLE financial_wallet_settings ADD payment_approval_limit_cents bigint CHECK (payment_approval_limit_cents BETWEEN 0 AND 99999999999999);
CREATE TABLE financial_settlement_approvals (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    receivable_id uuid, payable_id uuid,
    title_revision bigint NOT NULL CHECK (title_revision > 0),
    intent jsonb NOT NULL,
    reasons text[] NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','used')),
    requested_by text NOT NULL REFERENCES identities(auth_subject),
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    decided_by text REFERENCES identities(auth_subject), decided_at timestamptz, reason text,
    CHECK (num_nonnulls(receivable_id,payable_id)=1),
    CHECK (decided_by IS NULL OR requested_by<>decided_by),
    FOREIGN KEY (tenant_id,receivable_id) REFERENCES receivables(tenant_id,id),
    FOREIGN KEY (tenant_id,payable_id) REFERENCES payables(tenant_id,id)
);
ALTER TABLE financial_settlement_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_settlement_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON financial_settlement_approvals USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX settlement_approvals_receivable ON financial_settlement_approvals(tenant_id,receivable_id);
CREATE INDEX settlement_approvals_payable ON financial_settlement_approvals(tenant_id,payable_id);
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN GRANT SELECT,INSERT,UPDATE ON financial_settlement_approvals TO erp_next_app; END IF;
END $$;
INSERT INTO permissions(code,description) VALUES
    ('finance.settlements.approve','Aprovar pagamentos acima da alçada'),
    ('finance.charges.override','Alterar juros e multa calculados pela empresa')
ON CONFLICT DO NOTHING;

DO $migration$
DECLARE company uuid; previous_tenant text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY finance_wallet_migration_scan ON tenants FOR SELECT TO %I USING (true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        INSERT INTO role_permissions(role_id,permission_code)
          SELECT r.id,p.code FROM roles r CROSS JOIN permissions p
          WHERE r.tenant_id=company AND r.code='administrator'
            AND p.code IN ('finance.discounts.approve','finance.settlements.approve','finance.charges.override')
          ON CONFLICT DO NOTHING;
        UPDATE roles SET revision=revision+1 WHERE tenant_id=company AND code='administrator';
    END LOOP;
    PERFORM set_config('app.tenant_id',previous_tenant,true);
    DROP POLICY finance_wallet_migration_scan ON tenants;
END $migration$;
