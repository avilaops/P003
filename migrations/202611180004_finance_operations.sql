CREATE TABLE finance_operations (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    kind text NOT NULL CHECK (kind IN ('advance','allocation','offset','restructure','billing_group')),
    side text NOT NULL CHECK (side IN ('receivable','payable')),
    party_id uuid NOT NULL,
    occurred_on date NOT NULL,
    due_on date,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 200),
    principal_cents bigint NOT NULL CHECK (principal_cents BETWEEN 1 AND 99999999999999),
    interest_cents bigint NOT NULL DEFAULT 0 CHECK (interest_cents BETWEEN 0 AND 99999999999999),
    advance_id uuid,
    entry_id uuid,
    order_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id,id),
    FOREIGN KEY (tenant_id,party_id) REFERENCES parties(tenant_id,id),
    FOREIGN KEY (tenant_id,advance_id) REFERENCES finance_operations(tenant_id,id),
    FOREIGN KEY (tenant_id,entry_id) REFERENCES financial_account_entries(tenant_id,id),
    FOREIGN KEY (tenant_id,order_id) REFERENCES sales_orders(tenant_id,id),
    CHECK ((kind='advance')=(entry_id IS NOT NULL)),
    CHECK ((kind='allocation')=(advance_id IS NOT NULL)),
    CHECK (kind='advance' OR order_id IS NULL),
    CHECK (kind='restructure' OR interest_cents=0),
    CHECK ((kind='billing_group')=(due_on IS NOT NULL))
);
CREATE INDEX finance_operation_party_idx ON finance_operations(tenant_id,party_id,occurred_on,id);
CREATE INDEX finance_operation_advance_idx ON finance_operations(tenant_id,advance_id) WHERE advance_id IS NOT NULL;

ALTER TABLE receivables ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE receivables ADD COLUMN finance_operation_id uuid;
ALTER TABLE receivables ADD FOREIGN KEY (tenant_id,finance_operation_id) REFERENCES finance_operations(tenant_id,id);
ALTER TABLE receivables ADD CHECK (num_nonnulls(order_id,finance_operation_id)=1);
ALTER TABLE payables ADD COLUMN finance_operation_id uuid;
ALTER TABLE payables ADD FOREIGN KEY (tenant_id,finance_operation_id) REFERENCES finance_operations(tenant_id,id);
ALTER TABLE payables DROP CONSTRAINT payables_one_origin;
ALTER TABLE payables ADD CONSTRAINT payables_one_origin CHECK (num_nonnulls(receipt_id,staff_obligation_id,commission_closing_id,finance_operation_id)=1);

CREATE TABLE finance_operation_items (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    receivable_id uuid,
    payable_id uuid,
    receipt_payment_id uuid,
    payable_payment_id uuid,
    principal_cents bigint NOT NULL CHECK (principal_cents BETWEEN 1 AND 99999999999999),
    FOREIGN KEY (tenant_id,operation_id) REFERENCES finance_operations(tenant_id,id),
    FOREIGN KEY (tenant_id,receivable_id) REFERENCES receivables(tenant_id,id),
    FOREIGN KEY (tenant_id,payable_id) REFERENCES payables(tenant_id,id),
    FOREIGN KEY (tenant_id,receipt_payment_id) REFERENCES receivable_payments(tenant_id,id),
    FOREIGN KEY (tenant_id,payable_payment_id) REFERENCES payable_payments(tenant_id,id),
    CHECK (num_nonnulls(receivable_id,payable_id)=1),
    UNIQUE(tenant_id,operation_id,receivable_id),
    UNIQUE(tenant_id,operation_id,payable_id)
);
CREATE INDEX finance_operation_items_receivable ON finance_operation_items(tenant_id,receivable_id);
CREATE INDEX finance_operation_items_payable ON finance_operation_items(tenant_id,payable_id);

DO $isolation$
DECLARE relation text;
BEGIN
    FOREACH relation IN ARRAY ARRAY['finance_operations','finance_operation_items'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',relation);
        EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_audit_log_changes()',relation);
    END LOOP;
END $isolation$;

CREATE VIEW finance_portfolio WITH (security_invoker=true) AS
SELECT r.tenant_id,r.id,'receivable'::text AS side,r.customer_name AS party_name,
       coalesce(o.customer_id,op.party_id) AS party_id,r.order_id,r.finance_operation_id,r.category_id,r.cost_center_id,
       r.forecast_account_id,coalesce(r.competence_on,(r.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS competence_on,r.due_date,r.created_at,r.status,r.revision,r.amount_cents,
       coalesce(p.total,0)::bigint AS settled_cents,
       CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-coalesce(p.total,0) END::bigint AS open_cents
FROM receivables r
LEFT JOIN sales_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
LEFT JOIN finance_operations op ON (op.tenant_id,op.id)=(r.tenant_id,r.finance_operation_id)
LEFT JOIN LATERAL (
    SELECT sum(CASE WHEN kind='receipt' THEN amount_cents ELSE -amount_cents END) AS total
    FROM receivable_payments WHERE tenant_id=r.tenant_id AND receivable_id=r.id
) p ON true
UNION ALL
SELECT r.tenant_id,r.id,'payable',r.supplier_name,coalesce(o.supplier_id,op.party_id),NULL::uuid,r.finance_operation_id,r.category_id,r.cost_center_id,
       r.forecast_account_id,coalesce(r.competence_on,(r.created_at AT TIME ZONE 'America/Sao_Paulo')::date),r.due_date,r.created_at,r.status,r.revision,r.amount_cents,
       coalesce(p.total,0)::bigint,
       CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-coalesce(p.total,0) END::bigint
FROM payables r
LEFT JOIN purchase_receipts pr ON (pr.tenant_id,pr.id)=(r.tenant_id,r.receipt_id)
LEFT JOIN purchase_orders o ON (o.tenant_id,o.id)=(pr.tenant_id,pr.order_id)
LEFT JOIN finance_operations op ON (op.tenant_id,op.id)=(r.tenant_id,r.finance_operation_id)
LEFT JOIN LATERAL (
    SELECT sum(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END) AS total
    FROM payable_payments WHERE tenant_id=r.tenant_id AND payable_id=r.id
) p ON true;
