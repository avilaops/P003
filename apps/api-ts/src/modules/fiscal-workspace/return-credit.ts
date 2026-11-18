import {randomUUID} from "node:crypto"
import type {AuthorizedContext} from "../../platform/access.js"
import {record} from "../../platform/commands.js"
import {conflict} from "../orders/acceptance.js"
import type {CommandHeaders} from "../orders/receivables.js"

const paidSql=`LEFT JOIN LATERAL (SELECT coalesce(sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END),0) AS paid,
  (array_agg(p.id ORDER BY p.created_at DESC,p.id DESC) FILTER(WHERE p.kind='receipt' AND NOT EXISTS(SELECT FROM receivable_payments x
    WHERE x.tenant_id=p.tenant_id AND x.reverses_id=p.id)))[1] AS last_receipt
  FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id) p ON true`

export async function returnCreditTitles(c:AuthorizedContext,order:string,offset:number) {
  const rows=(await c.client.query(`SELECT r.id,d.number::text AS "orderNumber",r.due_date::text AS "dueOn",(r.amount_cents-p.paid)::text AS "openCents"
    FROM sales_orders origin JOIN sales_orders d ON d.tenant_id=origin.tenant_id AND d.customer_id=origin.customer_id
    JOIN receivables r ON r.tenant_id=d.tenant_id AND r.order_id=d.id ${paidSql}
    WHERE origin.tenant_id=$1 AND origin.id=$2 AND r.status='open' AND r.amount_cents>p.paid
    ORDER BY r.due_date,r.id LIMIT 16 OFFSET $3`,[c.tenantId,order,offset])).rows
  return {data:rows.slice(0,15),more:rows.length>15}
}

export async function applyReturnCredit(c:AuthorizedContext,headers:CommandHeaders,order:string,returnId:string,receivable:string,cents:string) {
  const credit=(await c.client.query<{customer_id:string;remaining:string}>(`SELECT so.customer_id,r.credited_cents-coalesce((SELECT sum(u.amount_cents) FROM sales_return_credit_applications u
    WHERE u.tenant_id=r.tenant_id AND u.return_id=r.id),0) AS remaining
    FROM sales_partial_returns r JOIN sales_invoice_lots l ON l.tenant_id=r.tenant_id AND l.id=r.lot_id
    JOIN sales_orders so ON so.tenant_id=l.tenant_id AND so.id=l.order_id
    WHERE r.tenant_id=$1 AND so.id=$2 AND r.id=$3 AND l.environment='production'`,[c.tenantId,order,returnId])).rows[0]
  const amount=BigInt(cents)
  if(!credit || BigInt(credit.remaining)<amount)conflict("Saldo de crédito da devolução insuficiente")
  const bill=(await c.client.query<{amount_cents:string;paid:string;last_receipt:string|null}>(`SELECT r.amount_cents,p.paid,p.last_receipt FROM receivables r JOIN sales_orders so ON so.tenant_id=r.tenant_id AND so.id=r.order_id
    ${paidSql} WHERE r.tenant_id=$1 AND r.id=$2 AND so.customer_id=$3 AND r.status='open' FOR UPDATE OF r`,[c.tenantId,receivable,credit.customer_id])).rows[0]
  if(!bill || BigInt(bill.amount_cents)-BigInt(bill.paid)<amount)conflict("Selecione um título em aberto do cliente com saldo suficiente")
  const face=BigInt(bill.amount_cents)-amount,status=face===0n?"cancelled":face===BigInt(bill.paid)?"paid":"open"
  await c.client.query("UPDATE receivables SET amount_cents=$3,status=$4,payment_id=$5,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
    [c.tenantId,receivable,face||bill.amount_cents,status,status==="paid"?bill.last_receipt:null])
  const id=randomUUID()
  await c.client.query("INSERT INTO sales_return_credit_applications(tenant_id,id,return_id,receivable_id,amount_cents) VALUES($1,$2,$3,$4,$5)",[c.tenantId,id,returnId,receivable,amount])
  await record(c,headers,"receivable",receivable,"receivable.abated",{returnId,applicationId:id,amountCents:cents,orderId:order})
  return id
}
