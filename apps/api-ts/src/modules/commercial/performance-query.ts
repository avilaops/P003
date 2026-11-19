// The rows retain their own event dates • order creation, acceptance, fiscal authorization, return and receipt.
export const facts = `WITH orders AS MATERIALIZED (
 SELECT o.*,ct.seller_staff_id AS seller_id,coalesce(ch.channel,q.public_snapshot#>>'{input,channel}','Direto') AS channel,
        q.public_snapshot,sm.accepted_at,sm.managerial,sm.net_sale_cents
 FROM sales_orders o LEFT JOIN sales_channel_orders ch ON (ch.tenant_id,ch.order_id)=(o.tenant_id,o.id)
 LEFT JOIN order_commission_terms ct ON (ct.tenant_id,ct.order_id)=(o.tenant_id,o.id)
 LEFT JOIN commercial_order_quotes q ON (q.tenant_id,q.order_id)=(o.tenant_id,o.id)
 LEFT JOIN sales_acceptance_margins sm ON (sm.tenant_id,sm.order_id)=(o.tenant_id,o.id)
 WHERE o.tenant_id=$1 AND ($4::uuid IS NULL OR ct.seller_staff_id=$4)
 AND ($5::text IS NULL OR coalesce(ch.channel,q.public_snapshot#>>'{input,channel}','Direto')=$5)
), lines AS MATERIALIZED (
 SELECT s.*,o.number,o.seller_id,o.channel,o.status,o.created_at,o.accepted_at,
 coalesce(o.public_snapshot#>>'{input,line}',j.item->>'line','catalog') AS product_line
 FROM orders o JOIN sales_order_lines s ON (s.tenant_id,s.order_id)=(o.tenant_id,o.id)
 LEFT JOIN LATERAL (SELECT item FROM jsonb_array_elements(o.public_snapshot#>'{input,items}') item WHERE item->>'productId'=s.product_id::text LIMIT 1) j ON true
), fiscal AS (
 SELECT fc.*,d.issued_at::timestamptz AS event_at,l.quantity_micros AS order_quantity,l.amount_cents AS ordered_cents,
 l.product_id,l.sku,l.name,l.seller_id,l.product_line,l.channel,
 round(fc.quantity_micros::numeric*l.amount_cents/l.quantity_micros) AS line_value,
 round(fc.quantity_micros::numeric*coalesce(order_line_fiscal_price(s),s.price_cents)/1000000) AS net_value,
 (SELECT round(nullif((xpath('string(/n:nfeProc/n:NFe/n:infNFe/n:total/n:ICMSTot/n:vNF)',xmlparse(document d.authorized_xml),
        ARRAY[ARRAY['n','http://www.portalfiscal.inf.br/nfe']]))[1]::text,'')::numeric*100)) AS fiscal_total
 FROM sales_invoice_costs fc JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(fc.tenant_id,fc.invoice_id)
 JOIN lines l ON (l.tenant_id,l.order_id,l.line_number)=(fc.tenant_id,fc.order_id,fc.line_number)
 JOIN sales_order_lines s ON (s.tenant_id,s.order_id,s.line_number)=(fc.tenant_id,fc.order_id,fc.line_number)
 WHERE d.status='authorized' AND d.environment='production'
), fiscal_weights AS (
 SELECT f.*,sum(line_value) OVER (PARTITION BY invoice_id) AS gross,
 sum(line_value) OVER (PARTITION BY invoice_id ORDER BY line_number) AS running FROM fiscal f
), billed AS MATERIALIZED (
 SELECT w.*,CASE WHEN fiscal_total IS NULL OR gross=0 THEN line_value
 ELSE round(fiscal_total*running/gross)-round(fiscal_total*(running-line_value)/gross) END AS amount
 FROM fiscal_weights w
), returns AS (
 SELECT r.created_at AS event_at,l.order_id,l.seller_id,l.product_line,l.product_id,l.name,l.sku,i.quantity_micros,i.value_cents,r.destination,
 round(b.net_value*i.quantity_micros/nullif(b.quantity_micros,0)) AS returned_net,
 CASE WHEN r.destination='stock' THEN round(b.cost_cents::numeric*i.quantity_micros/nullif(b.quantity_micros,0)) ELSE 0 END AS restored_cost
 FROM sales_partial_returns r JOIN sales_partial_return_items i ON i.tenant_id=r.tenant_id AND i.return_id=r.id
 JOIN sales_invoice_lots lot ON lot.tenant_id=r.tenant_id AND lot.id=r.lot_id AND lot.environment='production'
 JOIN lines l ON (l.tenant_id,l.order_id,l.line_number)=(r.tenant_id,lot.order_id,i.line_number)
 JOIN billed b ON b.invoice_id=lot.draft_id AND b.line_number=i.line_number
), events AS (
 SELECT 'accepted' AS basis,order_id,seller_id,product_line,product_id,name,sku,accepted_at AS event_at,quantity_micros,amount_cents AS amount
 FROM lines WHERE status<>'cancelled' AND accepted_at IS NOT NULL
 UNION ALL SELECT 'invoiced',order_id,seller_id,product_line,product_id,name,sku,event_at,quantity_micros,amount FROM billed
 UNION ALL SELECT 'invoiced',order_id,seller_id,product_line,product_id,name,sku,event_at,-quantity_micros,-value_cents FROM returns
), dates AS (SELECT $2::date::timestamp AT TIME ZONE 'America/Sao_Paulo' AS start_at,($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS end_at)
`

export const reportTotals = facts + `
SELECT count(*) FILTER(WHERE status<>'cancelled')::int AS orders, count(*) FILTER(WHERE status='cancelled')::int AS cancelled,
 coalesce(sum(amount_cents) FILTER(WHERE status<>'cancelled'),0)::text AS "orderedCents",
 coalesce(round(avg(amount_cents) FILTER(WHERE status<>'cancelled')),0)::text AS "averageCents",
 (SELECT coalesce(sum(amount),0)::text FROM billed,dates WHERE event_at>=start_at AND event_at<end_at) AS "invoicedCents",
 (SELECT coalesce(sum(value_cents),0)::text FROM returns,dates WHERE event_at>=start_at AND event_at<end_at) AS "returnedCents",
 (SELECT coalesce(sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END),0)::text FROM receivable_payments p
 JOIN receivables r ON (r.tenant_id,r.id)=(p.tenant_id,p.receivable_id) JOIN orders o ON o.id=r.order_id WHERE p.occurred_on BETWEEN $2 AND $3) AS "receivedCents"
 FROM orders,dates WHERE created_at>=start_at AND created_at<end_at`

export const abcQuery = facts + `
, products AS (SELECT product_id,min(sku) AS sku,min(name) AS name,sum(amount) AS value,sum(quantity_micros) AS quantity
 FROM events,dates WHERE basis=$6 AND event_at>=start_at AND event_at<end_at GROUP BY product_id),
 ranked AS (SELECT *,sum(greatest(value,0)) OVER() AS total,sum(greatest(value,0)) OVER(ORDER BY value DESC,product_id) AS running FROM products)
 SELECT product_id AS id,sku,name,value::text AS cents,quantity::text AS "quantityMicros",coalesce(round(10000*running/nullif(total,0)),0)::int AS "accumulatedBps",
 CASE WHEN value<=0 OR total=0 THEN 'C' WHEN (running-value)*100 < total*80 THEN 'A' WHEN (running-value)*100 < total*95 THEN 'B' ELSE 'C' END AS class
 FROM ranked ORDER BY value DESC,product_id`

export const marginQuery = facts + `
, movements AS (
 SELECT order_id,event_at,net_value AS revenue,cost_cents AS cost FROM billed
 UNION ALL SELECT order_id,event_at,-returned_net,-restored_cost FROM returns
), actual AS (
 SELECT order_id,sum(revenue) AS revenue,CASE WHEN count(*)=count(cost) THEN sum(cost) END AS cost FROM movements,dates
 WHERE event_at>=start_at AND event_at<end_at GROUP BY order_id
)
SELECT o.id,o.number::text,o.customer_name AS customer,o.channel,s.name AS seller,
 (o.managerial->>'netProfitCents') AS "forecastNetCents",
 (o.net_sale_cents-(o.managerial->>'equipmentCostCents')::numeric)::text AS "forecastGrossCents",
 a.revenue::text AS "actualRevenueCents",a.cost::text AS "actualCostCents",(a.revenue-a.cost)::text AS "actualGrossCents"
 FROM orders o CROSS JOIN dates LEFT JOIN actual a ON o.id=a.order_id LEFT JOIN staff s ON s.tenant_id=o.tenant_id AND s.id=o.seller_id
 WHERE (o.accepted_at>=start_at AND o.accepted_at<end_at AND o.status<>'cancelled') OR a.order_id IS NOT NULL
 ORDER BY o.number DESC`

export const goalQuery = facts + `
, target_progress AS (
 SELECT g.*,s.name,coalesce(sum(e.amount),0) AS achieved,coalesce(sum(e.quantity_micros),0) AS units,
 extract(day FROM (g.month+interval '1 month - 1 day'))::int AS total_days,
 greatest(0,least((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date,(g.month+interval '1 month - 1 day')::date)-g.month+1) AS elapsed
 FROM sales_targets g JOIN staff s ON s.tenant_id=g.tenant_id AND s.id=g.seller_id
 LEFT JOIN events e ON e.seller_id=g.seller_id AND e.product_line=g.product_line AND e.basis=g.basis
 AND e.event_at>=g.month::timestamp AT TIME ZONE 'America/Sao_Paulo' AND e.event_at<(g.month+interval '1 month') AT TIME ZONE 'America/Sao_Paulo'
 WHERE g.tenant_id=$1 AND g.month BETWEEN date_trunc('month',$2::date)::date AND date_trunc('month',$3::date)::date
 AND ($4::uuid IS NULL OR g.seller_id=$4)
 GROUP BY g.tenant_id,g.seller_id,g.month,g.product_line,s.name
)
SELECT seller_id AS "sellerId",name AS seller,to_char(month,'YYYY-MM') AS month,product_line AS line,basis,revision::int,
 amount_cents::text AS "targetCents",quantity_micros::text AS "targetMicros",alert_bps AS "alertBps",
 achieved::text AS "achievedCents",units::text AS "achievedMicros",round(achieved*10000/amount_cents)::int AS "achievedBps",
 round(units*10000/quantity_micros)::int AS "quantityBps",
 round(achieved*total_days/nullif(elapsed,0))::text AS "projectedCents",
 (elapsed>0 AND achieved*total_days*10000<amount_cents::numeric*elapsed*alert_bps) AS alert
 FROM target_progress ORDER BY month DESC,name,product_line`

export const ordersQuery = facts + `
, origin AS (
 SELECT id,CASE WHEN status='cancelled' THEN 0 ELSE amount_cents END AS ordered,0::numeric AS invoiced,0::numeric AS returned,0::numeric AS received
 FROM orders,dates WHERE created_at>=start_at AND created_at<end_at
 UNION ALL SELECT order_id,0,amount,0,0 FROM billed,dates WHERE event_at>=start_at AND event_at<end_at
 UNION ALL SELECT order_id,0,0,value_cents,0 FROM returns,dates WHERE event_at>=start_at AND event_at<end_at
 UNION ALL SELECT o.id,0,0,0,CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END FROM receivable_payments p
 JOIN receivables r ON (r.tenant_id,r.id)=(p.tenant_id,p.receivable_id) JOIN orders o ON o.id=r.order_id
 WHERE $6::boolean AND p.occurred_on BETWEEN $2 AND $3
), amounts AS (
 SELECT id,sum(ordered)::text AS cents,sum(invoiced)::text AS "invoicedCents",sum(returned)::text AS "returnedCents",
 CASE WHEN $6::boolean THEN sum(received)::text END AS "receivedCents" FROM origin GROUP BY id
)
SELECT amounts.*,o.created_at>=dates.start_at AND o.created_at<dates.end_at AS "createdInPeriod",o.number::text,o.customer_name AS customer,o.channel,s.name AS seller,o.status,
 (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS date
 FROM amounts JOIN orders o ON o.id=amounts.id CROSS JOIN dates LEFT JOIN staff s ON (s.tenant_id,s.id)=(o.tenant_id,o.seller_id) ORDER BY o.number DESC`
