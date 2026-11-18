CREATE TABLE finance_company_period_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('close','reopen')),
  through_date date NOT NULL, reason text NOT NULL, recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY(tenant_id,id)
);
CREATE INDEX finance_company_period_latest ON finance_company_period_events(tenant_id,through_date,sequence DESC);
ALTER TABLE finance_company_period_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_company_period_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON finance_company_period_events
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE VIEW finance_company_closed_dates WITH (security_invoker=true) AS
 SELECT tenant_id,through_date FROM (
   SELECT DISTINCT ON(tenant_id,through_date) tenant_id,through_date,action
   FROM finance_company_period_events ORDER BY tenant_id,through_date,sequence DESC
 ) latest WHERE action='close';

CREATE FUNCTION finance_company_date_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE effective_date date;
BEGIN
 IF TG_TABLE_NAME='pos_sessions' THEN
   effective_date := (coalesce(NEW.closed_at,NEW.opened_at) AT TIME ZONE 'America/Sao_Paulo')::date;
 ELSE
   effective_date := NEW.occurred_on;
 END IF;
 PERFORM 1 FROM tenants WHERE id=NEW.tenant_id FOR UPDATE;
 IF EXISTS (SELECT FROM finance_company_closed_dates WHERE tenant_id=NEW.tenant_id AND through_date>=effective_date) THEN
   RAISE EXCEPTION 'Período financeiro da empresa encerrado' USING ERRCODE='PF001';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['receivable_payments','payable_payments','financial_account_entries','finance_operations','finance_operation_reversals']
 LOOP EXECUTE format('CREATE TRIGGER finance_company_date_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION finance_company_date_guard()',relation); END LOOP;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
   GRANT SELECT,INSERT ON finance_company_period_events TO erp_next_app;
   GRANT SELECT ON finance_company_closed_dates TO erp_next_app;
 END IF;
END $$;
CREATE TRIGGER finance_company_date_guard BEFORE INSERT OR UPDATE OF closed_at ON pos_sessions
 FOR EACH ROW EXECUTE FUNCTION finance_company_date_guard();
