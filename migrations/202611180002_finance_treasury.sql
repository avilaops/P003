CREATE TABLE finance_bank_statements (
    tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL,
    bank_id text NOT NULL, bank_account text NOT NULL, digest text NOT NULL,
    from_date date NOT NULL, through_date date NOT NULL CHECK(through_date>=from_date), closing_cents bigint,
    imported_at timestamptz NOT NULL DEFAULT now(), imported_by text NOT NULL,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,account_id,digest),
    FOREIGN KEY (tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id)
);
CREATE TABLE finance_bank_lines (
    tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, statement_id uuid NOT NULL,
    fit_id text NOT NULL, booked_on date NOT NULL, signed_cents bigint NOT NULL CHECK(signed_cents <> 0),
    description text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','matched','exception')),
    reason text, reviewed_by text, reviewed_at timestamptz,
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,account_id,fit_id),
    FOREIGN KEY(tenant_id,statement_id) REFERENCES finance_bank_statements(tenant_id,id),
    FOREIGN KEY(tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id)
);
CREATE INDEX finance_bank_lines_date ON finance_bank_lines(tenant_id,account_id,booked_on,id);
CREATE TABLE finance_bank_matches (
    tenant_id uuid NOT NULL, line_id uuid NOT NULL, entry_id uuid NOT NULL,
    PRIMARY KEY(tenant_id,line_id,entry_id), UNIQUE(tenant_id,entry_id),
    FOREIGN KEY(tenant_id,line_id) REFERENCES finance_bank_lines(tenant_id,id),
    FOREIGN KEY(tenant_id,entry_id) REFERENCES financial_account_entries(tenant_id,id)
);
CREATE TABLE finance_account_periods (
    tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, through_date date NOT NULL,
    closed_by text NOT NULL, closed_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL,
    reopened_by text, reopened_at timestamptz, reopen_reason text,
    PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id)
);
CREATE UNIQUE INDEX finance_period_active ON finance_account_periods(tenant_id,account_id,through_date) WHERE reopened_at IS NULL;
CREATE FUNCTION finance_guard_closed_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account uuid; movement_date date;
BEGIN
    IF TG_TABLE_NAME = 'pos_sessions' THEN
        account := NEW.cash_account_id;
        movement_date := COALESCE(NEW.closed_at,NEW.opened_at) AT TIME ZONE 'America/Sao_Paulo';
    ELSE
        account := NEW.account_id;
        movement_date := NEW.occurred_on;
    END IF;
    PERFORM 1 FROM financial_accounts WHERE tenant_id=NEW.tenant_id AND id=account FOR UPDATE;
    IF EXISTS(SELECT 1 FROM finance_account_periods WHERE tenant_id=NEW.tenant_id
              AND account_id=account AND reopened_at IS NULL AND through_date>=movement_date) THEN
        RAISE EXCEPTION 'Período financeiro fechado' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_ledger_period BEFORE INSERT ON financial_account_entries
    FOR EACH ROW EXECUTE FUNCTION finance_guard_closed_period();
CREATE TRIGGER finance_guard_session_period BEFORE INSERT OR UPDATE ON pos_sessions
    FOR EACH ROW EXECUTE FUNCTION finance_guard_closed_period();

INSERT INTO permissions(code,description) VALUES
('finance.reconciliation.close','Fechar períodos por conta financeira'),
('finance.reconciliation.reopen','Reabrir períodos financeiros com justificativa'),
('finance.collections.manage','Emitir cobranças e processar arquivos bancários'),
('finance.collections.read','Consultar cobranças e arquivos bancários') ON CONFLICT DO NOTHING;

CREATE TABLE finance_collection_charges (
    tenant_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, party_id uuid NOT NULL,
    group_id uuid, live_mode boolean NOT NULL, collector_id text NOT NULL, method text NOT NULL CHECK(method IN ('PIX','BOLETO')),
    amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 99999999999999),
    due_on date NOT NULL, state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','issued','paid','review')),
    provider_id text, provider_request jsonb NOT NULL, instructions jsonb, issue_key uuid NOT NULL,
    fee_entry_id uuid, review_reason text, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
    PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,group_id), UNIQUE(tenant_id,provider_id), UNIQUE(tenant_id,issue_key),
    FOREIGN KEY(tenant_id,account_id) REFERENCES financial_accounts(tenant_id,id),
    FOREIGN KEY(tenant_id,party_id) REFERENCES parties(tenant_id,id),
    FOREIGN KEY(tenant_id,fee_entry_id) REFERENCES financial_account_entries(tenant_id,id)
);
CREATE TABLE finance_collection_items (
    tenant_id uuid NOT NULL, charge_id uuid NOT NULL, receivable_id uuid NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents>0), payment_id uuid,
    PRIMARY KEY(tenant_id,charge_id,receivable_id), UNIQUE(tenant_id,receivable_id),
    FOREIGN KEY(tenant_id,charge_id) REFERENCES finance_collection_charges(tenant_id,id),
    FOREIGN KEY(tenant_id,receivable_id) REFERENCES receivables(tenant_id,id),
    FOREIGN KEY(tenant_id,receivable_id,payment_id) REFERENCES receivable_payments(tenant_id,receivable_id,id)
);
CREATE TABLE finance_collection_events (
    tenant_id uuid NOT NULL, charge_id uuid NOT NULL, source text NOT NULL, event_key text NOT NULL,
    outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,source,event_key), FOREIGN KEY(tenant_id,charge_id) REFERENCES finance_collection_charges(tenant_id,id)
);
CREATE TABLE finance_collection_imports (
    tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id)
);

DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['finance_bank_statements','finance_bank_lines','finance_bank_matches','finance_account_periods','finance_collection_charges','finance_collection_items','finance_collection_events','finance_collection_imports'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tbl);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='erp_next_app') THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO erp_next_app',tbl);
  END IF;
 END LOOP;
END $$;
