import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { salesListSchema, orderSearchNumber } from "./shared.js"
import { expiringProposalDays } from "../pending-work/parameters.js"

const filterSchema=salesListSchema.extend({
  view:z.literal("workspace"), from:z.iso.date().optional(), to:z.iso.date().optional(),
  seller:z.string().trim().max(100).default(""), includeCancelled:z.enum(["true","false"]).default("false"),
  validity:z.enum(["","current","expired","expiring"]).default(""), stale:z.enum(["true","false"]).default("false"),
  stage:z.enum(["","approval","production","billed","partial","delivered"]).default("")
})
const localToday="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
const orderRows=`
  SELECT o.id,o.number::text AS number,o.revision,o.customer_name AS "customerName",o.customer_tax_id AS "customerTaxId",o.status,
    o.amount_cents,o.created_at,o.updated_at,coalesce(t.seller_name,owner.name) AS seller,
    CASE WHEN t.seller_name IS NOT NULL THEN 'seller' WHEN owner.name IS NOT NULL THEN 'owner' END AS "sellerKind",
    CASE WHEN bills.total>0 THEN bills.due WHEN schedule.total>0 THEN schedule.due ELSE o.due_date END::text AS "dueDate",
    CASE WHEN bills.total>0 AND bills.due IS NULL THEN 'settled' WHEN bills.total>0 THEN 'open' ELSE 'scheduled' END AS "dueKind",
    quote.order_id IS NOT NULL OR ps.order_id IS NOT NULL AS "pricingOrigin",
    CASE WHEN o.status='draft' THEN ${localToday}-(o.updated_at AT TIME ZONE 'America/Sao_Paulo')::date ELSE 0 END AS "staleDays",
    CASE WHEN o.status='cancelled' THEN NULL WHEN lots.delivered THEN 'delivered' WHEN lots.partial_delivery THEN 'partial'
      WHEN docs.full_billed OR lots.fully_billed THEN 'billed' WHEN lots.any_billed THEN 'partial'
      WHEN prod.active THEN 'production' WHEN quote.approval_status='pending' THEN 'approval' END AS stage
  FROM sales_orders o LEFT JOIN order_commission_terms t ON t.tenant_id=o.tenant_id AND t.order_id=o.id
    LEFT JOIN LATERAL (SELECT i.display_name AS name FROM sales_opportunities a JOIN identities i ON i.id::text=a.data->>'ownerId'
      WHERE a.tenant_id=o.tenant_id AND a.order_id=o.id ORDER BY a.updated_at DESC,a.id LIMIT 1) owner ON true
    LEFT JOIN commercial_order_quotes quote ON quote.tenant_id=o.tenant_id AND quote.order_id=o.id
    LEFT JOIN order_pricing_snapshots ps ON ps.tenant_id=o.tenant_id AND ps.order_id=o.id
    LEFT JOIN LATERAL (SELECT count(*) AS total,min(r.due_date) FILTER(WHERE r.status='open') AS due FROM receivables r
      WHERE $15 AND r.tenant_id=o.tenant_id AND r.order_id=o.id) bills ON true
    LEFT JOIN LATERAL (SELECT count(*) AS total,min(due_on) AS due FROM sales_order_installments i
      WHERE i.tenant_id=o.tenant_id AND i.order_id=o.id) schedule ON true
    LEFT JOIN LATERAL (SELECT EXISTS(SELECT FROM production_orders p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id AND p.status='open') AS active) prod ON true
    LEFT JOIN LATERAL (SELECT EXISTS(SELECT FROM fiscal_nfe_documents d WHERE d.tenant_id=o.tenant_id AND d.source_order_id=o.id AND d.environment='production' AND d.status='authorized') AS full_billed) docs ON true
    LEFT JOIN LATERAL (SELECT bool_and(ship>=s.quantity_micros) AS delivered,bool_or(ship>0) AS partial_delivery,
      bool_and(bill>=s.quantity_micros) AS fully_billed,bool_or(bill>0) AS any_billed
      FROM sales_order_lines s CROSS JOIN LATERAL (
        SELECT coalesce(sum(i.quantity_micros) FILTER(WHERE l.delivered_at IS NOT NULL),0) AS ship,
        coalesce(sum(i.quantity_micros) FILTER(WHERE e.status='authorized'),0) AS bill
        FROM sales_invoice_lot_items i JOIN sales_invoice_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
        LEFT JOIN fiscal_nfe_documents e ON e.tenant_id=l.tenant_id AND e.id=l.draft_id
        WHERE i.tenant_id=s.tenant_id AND i.order_id=s.order_id AND i.line_number=s.line_number AND l.environment='production' AND NOT l.withdrawn) movement
      WHERE s.tenant_id=o.tenant_id AND s.order_id=o.id) lots ON true
  WHERE o.tenant_id=$1`
const proposalRows=`
  SELECT p.id,p.number::text AS number,p.revision,v.version,v.customer_name AS "customerName",v.customer_tax_id AS "customerTaxId",v.status,
    v.amount_cents,p.created_at,p.updated_at,coalesce(t.seller_name,owner.name) AS seller,
    CASE WHEN t.seller_name IS NOT NULL THEN 'seller' WHEN owner.name IS NOT NULL THEN 'owner' END AS "sellerKind",
    v.valid_until::text AS "validUntil",v.status='sent' AND v.valid_until<${localToday} AS expired,
    v.valid_until<${localToday} AS "pastValidity",0 AS "staleDays",NULL::text AS stage
  FROM sales_proposals p JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id AND v.version=p.current_version
    LEFT JOIN order_commission_terms t ON t.tenant_id=p.tenant_id AND t.order_id=p.order_id
    LEFT JOIN LATERAL (SELECT i.display_name AS name FROM sales_opportunities a JOIN identities i ON i.id::text=a.data->>'ownerId'
      WHERE a.tenant_id=p.tenant_id AND a.proposal_id=p.id ORDER BY a.updated_at DESC,a.id LIMIT 1) owner ON true
  WHERE p.tenant_id=$1`

export async function recordWorkspace(c:AuthorizedContext,raw:unknown,kind:"orders"|"proposals") {
  const parsed=filterSchema.safeParse(raw),orders=kind==="orders"
  if (!parsed.success || parsed.data.from && parsed.data.to && parsed.data.from>parsed.data.to) throw new Problem(422,"invalid_input","Confira o período e os filtros da lista")
  const f=parsed.data, statuses=orders ? ["","draft","accepted","confirmed","completed","cancelled"] : ["","draft","sent","accepted","rejected","cancelled","expired"]
  if (!statuses.includes(f.status) || (orders && f.validity || !orders && (f.stage || f.stale==="true")) || /\p{Cc}/u.test(f.q)) throw new Problem(422,"invalid_input","Filtros incompatíveis com a lista")
  const digits=/^[\d./\s-]+$/.test(f.q) ? f.q.replace(/\D/g,"") : ""
  const orderBy=f.sort==="updated" ? "updated_at" : "created_at"
  const sql=`WITH rows AS (${orders?orderRows:proposalRows}), filtered AS MATERIALIZED (
      SELECT rows.*, (amount_cents/100::numeric)::numeric(18,2)::text AS amount FROM rows
      WHERE ($2='' OR strpos(lower("customerName"),lower($2))>0 OR strpos(id::text,lower($2))>0 OR ($3<>'' AND strpos("customerTaxId",$3)>0) OR number=$4)
        AND ($5='' OR ${orders ? "status=$5" : "(status=$5 AND ($5<>'sent' OR NOT expired)) OR ($5='expired' AND expired)"})
        AND ($6::date IS NULL OR created_at>=($6::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        AND ($7::date IS NULL OR created_at<(($7::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        AND ($8='' OR strpos(lower(seller),lower($8))>0) AND ($9 OR status<>'cancelled' OR $5='cancelled')
        AND ($10='' OR ${orders ? "false" : `CASE WHEN $10='expiring' THEN status='sent' AND NOT "pastValidity" AND "validUntil"::date<=${localToday}+${expiringProposalDays} ELSE ($10='expired')="pastValidity" END`}) AND (NOT $11 OR "staleDays">7) AND ($12='' OR stage=$12)
    ), page AS (SELECT * FROM filtered ORDER BY ${orderBy} DESC,id DESC LIMIT $13 OFFSET $14)
    SELECT (SELECT count(*)::int FROM filtered) AS total,(SELECT (coalesce(sum(amount_cents),0)/100::numeric)::numeric(30,2)::text FROM filtered) AS "totalAmount",
       coalesce(jsonb_agg(to_jsonb(page)-'amount_cents'-'created_at'-'updated_at' ORDER BY ${orderBy} DESC,id DESC),'[]') AS data FROM page`
  const args=[c.tenantId,f.q.trim(),digits,orderSearchNumber(f.q.trim()),f.status,f.from,f.to,f.seller,
    f.includeCancelled==="true" || !orders,f.validity,f.stale==="true",f.stage,f.limit,f.offset,...(orders ? [c.permissions.some(p=>p==="finance.receivables.read" || p==="finance.receivables.manage")] : [])]
  const result=(await c.client.query(sql,args)).rows[0]
  return {tenantId:c.tenantId,canEdit:c.permissions.includes(orders ? "sales.orders.manage":"sales.proposals.manage"),offset:f.offset,limit:f.limit,...result}
}
