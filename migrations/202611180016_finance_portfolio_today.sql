CREATE INDEX receivable_payments_occurrence ON receivable_payments(tenant_id, occurred_on, receivable_id);
CREATE INDEX payable_payments_occurrence ON payable_payments(tenant_id, occurred_on, payable_id);

-- The command-side portfolio includes every booking, so a future receipt still reserves its principal.
CREATE VIEW finance_portfolio_today WITH (security_invoker=true) AS
WITH future_payments AS (
    SELECT tenant_id,receivable_id AS id,'receivable' AS side,min(occurred_on) AS next_day,
           sum(CASE WHEN kind='receipt' THEN amount_cents ELSE -amount_cents END) AS net,
           sum(amount_cents) FILTER (WHERE kind='receipt') AS reserved
    FROM receivable_payments WHERE occurred_on>(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date
    GROUP BY tenant_id,receivable_id
    UNION ALL
    SELECT tenant_id,payable_id,'payable',min(occurred_on),
           sum(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END),
           sum(amount_cents) FILTER (WHERE kind='payment')
    FROM payable_payments WHERE occurred_on>(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date
    GROUP BY tenant_id,payable_id
), position AS (
    SELECT p.*,p.settled_cents-coalesce(f.net,0) AS settled_today,coalesce(f.reserved,0) AS reserved,
           coalesce(op.occurred_on<=(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date,true) AS exists_today,
           p.status='cancelled' AND coalesce(rev.occurred_on<=(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date,true) AS cancelled_today,
           least(f.next_day,CASE WHEN rev.occurred_on>(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date THEN rev.occurred_on END) AS next_movement_on
    FROM finance_portfolio p LEFT JOIN future_payments f USING (tenant_id,side,id)
    LEFT JOIN finance_operations op ON (op.tenant_id,op.id)=(p.tenant_id,p.finance_operation_id)
    LEFT JOIN finance_operation_reversals rev ON (rev.tenant_id,rev.operation_id)=(op.tenant_id,op.id)
)
SELECT tenant_id,id,side,party_name,party_id,order_id,finance_operation_id,category_id,cost_center_id,
       forecast_account_id,competence_on,due_date,created_at,revision,amount_cents,exists_today,next_movement_on,
       settled_today::bigint AS settled_cents,open_cents AS operational_open_cents,
       CASE WHEN next_movement_on IS NULL THEN status WHEN cancelled_today THEN 'cancelled'
            WHEN settled_today>=amount_cents THEN 'paid' ELSE 'open' END AS status,
       CASE WHEN cancelled_today THEN 0 ELSE amount_cents-settled_today END::bigint AS open_cents,
       CASE WHEN status='cancelled' THEN 0 ELSE greatest(amount_cents-settled_today-reserved,0) END::bigint AS forecast_cents
FROM position;

DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='erp_next_app') THEN
        GRANT SELECT ON finance_portfolio_today TO erp_next_app;
    END IF;
END $$;
