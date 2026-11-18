ALTER TABLE order_commission_terms ADD COLUMN use_policies boolean NOT NULL DEFAULT false;

CREATE TABLE commission_policies (
    tenant_id uuid NOT NULL, id uuid NOT NULL, seller_staff_id uuid NOT NULL,
    product_id uuid, product_line text CHECK (product_line IN ('national','imported')),
    trigger_event text NOT NULL CHECK (trigger_event IN ('receipt','invoice')),
    commission_rate bigint NOT NULL CHECK (commission_rate BETWEEN 0 AND 1000000),
    PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,seller_staff_id) REFERENCES staff(tenant_id,id),
    FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
    CHECK (num_nonnulls(product_id,product_line)<=1)
);
CREATE UNIQUE INDEX commission_policy_product ON commission_policies(tenant_id,seller_staff_id,product_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX commission_policy_line ON commission_policies(tenant_id,seller_staff_id,product_line) WHERE product_line IS NOT NULL;
CREATE UNIQUE INDEX commission_policy_default ON commission_policies(tenant_id,seller_staff_id) WHERE product_id IS NULL AND product_line IS NULL;

CREATE TABLE order_commission_lines (
    tenant_id uuid NOT NULL, order_id uuid NOT NULL, product_id uuid NOT NULL,
    line_number integer NOT NULL, weight_cents bigint NOT NULL CHECK(weight_cents>=0),
    trigger_event text NOT NULL CHECK(trigger_event IN ('receipt','invoice')),
    commission_rate bigint NOT NULL CHECK(commission_rate BETWEEN 0 AND 1000000),
    policy_id uuid, PRIMARY KEY(tenant_id,order_id,product_id),
    FOREIGN KEY(tenant_id,order_id) REFERENCES order_commission_terms(tenant_id,order_id),
    FOREIGN KEY(tenant_id,policy_id) REFERENCES commission_policies(tenant_id,id)
);
ALTER TABLE commission_entries DROP CONSTRAINT commission_entries_kind_check,
    DROP CONSTRAINT commission_entries_check, DROP CONSTRAINT commission_entries_tenant_id_receipt_id_key,
    DROP CONSTRAINT commission_entries_tenant_id_reversal_id_key,
    ADD COLUMN product_id uuid, ADD COLUMN invoice_id uuid, ADD COLUMN source_date date,
    ADD FOREIGN KEY(tenant_id,invoice_id) REFERENCES fiscal_nfe_documents(tenant_id,id),
    ADD FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
    ADD CHECK (
        (kind='adjustment' AND num_nonnulls(receipt_id,reversal_id,reverses_entry_id,invoice_id)=0 AND commission_rate IS NULL AND ipi_rate IS NULL AND base_cents=0 AND amount_cents<>0)
        OR (order_id IS NOT NULL AND commission_rate IS NOT NULL AND ipi_rate IS NOT NULL AND (
            (kind='receipt' AND receipt_id IS NOT NULL AND num_nonnulls(reversal_id,reverses_entry_id,invoice_id)=0 AND amount_cents>=0 AND base_cents>=0)
            OR (kind='invoice' AND invoice_id IS NOT NULL AND num_nonnulls(receipt_id,reversal_id,reverses_entry_id)=0 AND amount_cents>=0 AND base_cents>=0)
            OR (kind='reversal' AND reversal_id IS NOT NULL AND reverses_entry_id IS NOT NULL AND num_nonnulls(receipt_id,invoice_id)=0 AND amount_cents<=0 AND base_cents<=0)
            OR (kind='invoice_reversal' AND invoice_id IS NOT NULL AND reverses_entry_id IS NOT NULL AND num_nonnulls(receipt_id,reversal_id)=0 AND amount_cents<=0 AND base_cents<=0)
        )))
;
CREATE UNIQUE INDEX commission_receipt_line ON commission_entries(tenant_id,receipt_id,order_id,COALESCE(product_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE kind='receipt';
CREATE UNIQUE INDEX commission_invoice_line ON commission_entries(tenant_id,invoice_id,product_id) WHERE kind='invoice';

CREATE TABLE commission_closings (
    tenant_id uuid NOT NULL, id uuid NOT NULL, seller_staff_id uuid NOT NULL, competence date NOT NULL CHECK(extract(day FROM competence)=1),
    due_date date NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>0), reason text NOT NULL, approved_by text NOT NULL,
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,seller_staff_id,competence), UNIQUE(tenant_id,seller_staff_id,id),
    FOREIGN KEY(tenant_id,seller_staff_id) REFERENCES commission_accounts(tenant_id,seller_staff_id)
);
CREATE TABLE commission_closing_entries (
    tenant_id uuid NOT NULL,seller_staff_id uuid NOT NULL,entry_id uuid NOT NULL,closing_id uuid NOT NULL,
    PRIMARY KEY(tenant_id,entry_id),
    FOREIGN KEY(tenant_id,seller_staff_id,entry_id) REFERENCES commission_entries(tenant_id,seller_staff_id,id),
    FOREIGN KEY(tenant_id,seller_staff_id,closing_id) REFERENCES commission_closings(tenant_id,seller_staff_id,id)
);
ALTER TABLE payables ADD COLUMN commission_closing_id uuid,
    ADD FOREIGN KEY(tenant_id,commission_closing_id) REFERENCES commission_closings(tenant_id,id),
    ADD UNIQUE(tenant_id,commission_closing_id), DROP CONSTRAINT payables_one_origin;
ALTER TABLE payables ADD CONSTRAINT payables_one_origin CHECK(num_nonnulls(receipt_id,staff_obligation_id,commission_closing_id)=1);

CREATE TABLE accounting_accounts (
    tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
    classification text NOT NULL CHECK(classification IN ('asset','liability','equity','revenue','expense')),
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE accounting_rules (
    tenant_id uuid NOT NULL, event_type text NOT NULL, debit_id uuid NOT NULL, credit_id uuid NOT NULL,
    PRIMARY KEY(tenant_id,event_type), CHECK(debit_id<>credit_id),
    FOREIGN KEY(tenant_id,debit_id) REFERENCES accounting_accounts(tenant_id,id),
    FOREIGN KEY(tenant_id,credit_id) REFERENCES accounting_accounts(tenant_id,id)
);
CREATE TABLE accounting_events (
    tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, event_type text NOT NULL, source_id uuid NOT NULL,
    document_type text NOT NULL, document_id uuid NOT NULL, occurred_on date NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>0),
    reverses_event_id uuid, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_type,source_id),
    FOREIGN KEY(tenant_id,reverses_event_id) REFERENCES accounting_events(tenant_id,id)
);
CREATE TABLE accounting_entries (
    tenant_id uuid NOT NULL, id uuid NOT NULL, event_id uuid NOT NULL, debit_id uuid NOT NULL, credit_id uuid NOT NULL,
    occurred_on date NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>0), reverses_entry_id uuid, memo text NOT NULL,
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,event_id), UNIQUE(tenant_id,reverses_entry_id),
    CHECK(debit_id<>credit_id), FOREIGN KEY(tenant_id,event_id) REFERENCES accounting_events(tenant_id,id),
    FOREIGN KEY(tenant_id,debit_id) REFERENCES accounting_accounts(tenant_id,id),
    FOREIGN KEY(tenant_id,credit_id) REFERENCES accounting_accounts(tenant_id,id),
    FOREIGN KEY(tenant_id,reverses_entry_id) REFERENCES accounting_entries(tenant_id,id)
);
CREATE INDEX accounting_entry_period ON accounting_entries(tenant_id,occurred_on,id);
CREATE TABLE accounting_periods (
    tenant_id uuid NOT NULL REFERENCES tenants(id), month date NOT NULL CHECK(extract(day FROM month)=1),
    closed boolean NOT NULL, reason text NOT NULL, changed_by text NOT NULL, PRIMARY KEY(tenant_id,month)
);
CREATE TABLE accounting_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
-- Capture fiscal status changes from every emitter. The ERP consumes each source exactly once.
CREATE TABLE finance_invoice_events (
    tenant_id uuid NOT NULL, invoice_id uuid NOT NULL, event_type text NOT NULL, occurred_on date NOT NULL,
    processed boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,invoice_id,event_type),
    FOREIGN KEY(tenant_id,invoice_id) REFERENCES fiscal_nfe_documents(tenant_id,id)
);
CREATE FUNCTION capture_finance_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.environment='production' AND NEW.source_order_id IS NOT NULL AND NEW.status IN ('authorized','cancelled') THEN
        INSERT INTO finance_invoice_events(tenant_id,invoice_id,event_type,occurred_on)
        VALUES(NEW.tenant_id,NEW.id,NEW.status,CASE WHEN NEW.status='authorized' THEN left(NEW.issued_at,10)::date ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date END)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER finance_capture_invoice AFTER INSERT OR UPDATE OF status ON fiscal_nfe_documents
    FOR EACH ROW EXECUTE FUNCTION capture_finance_invoice();

DO $$ DECLARE item text;
BEGIN
    FOREACH item IN ARRAY ARRAY['commission_policies','order_commission_lines','commission_closings','commission_closing_entries','accounting_accounts','accounting_rules','accounting_events','accounting_entries','accounting_periods','accounting_settings','finance_invoice_events'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',item);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',item);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',item);
    END LOOP;
    FOREACH item IN ARRAY ARRAY['order_commission_lines','commission_closings','commission_closing_entries','accounting_events','accounting_entries'] LOOP
        EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes()',item);
    END LOOP;
END $$;
INSERT INTO permissions(code,description) VALUES
    ('finance.accounting.read','Consultar plano de contas, diário, razão e balancete'),
    ('finance.accounting.manage','Configurar contabilização, estornar e encerrar competência')
ON CONFLICT DO NOTHING;
DO $$ DECLARE company uuid; previous text:=coalesce(current_setting('app.tenant_id',true),'');
BEGIN
    EXECUTE format('CREATE POLICY management_migration_scan ON tenants FOR SELECT TO %I USING(true)',current_user);
    FOR company IN SELECT id FROM tenants LOOP
        PERFORM set_config('app.tenant_id',company::text,true);
        INSERT INTO role_permissions(role_id,permission_code)
        SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.tenant_id=company AND r.code IN ('admin','administrator') AND p.code LIKE 'finance.accounting.%' ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM set_config('app.tenant_id',previous,true);
    DROP POLICY management_migration_scan ON tenants;
END $$;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT,INSERT,UPDATE ON commission_policies,accounting_settings,accounting_rules,accounting_periods,finance_invoice_events TO erp_next_app;
        GRANT SELECT,INSERT ON order_commission_lines,commission_closings,commission_closing_entries,accounting_accounts,accounting_events,accounting_entries TO erp_next_app;
    END IF;
END $$;
-- The worker may discover companies with pending events. Processing still uses ordinary tenant RLS.
DO $$ BEGIN
    EXECUTE format('CREATE POLICY fiscal_event_worker_discovery ON finance_invoice_events FOR SELECT TO %I USING(current_setting(''app.discover_finance_invoices'',true)=''on'')',current_user);
END $$;
CREATE FUNCTION finance_pending_invoice_tenants() RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text:=coalesce(current_setting('app.discover_finance_invoices',true),'');
BEGIN
    PERFORM set_config('app.discover_finance_invoices','on',true);
    RETURN QUERY SELECT DISTINCT q.tenant_id FROM public.finance_invoice_events q WHERE NOT q.processed;
    PERFORM set_config('app.discover_finance_invoices',previous,true);
END $$;
REVOKE ALL ON FUNCTION finance_pending_invoice_tenants() FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT EXECUTE ON FUNCTION finance_pending_invoice_tenants() TO erp_next_app;
    END IF;
END $$;
CREATE INDEX accounting_events_source ON accounting_events(tenant_id,source_id);
