import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue, type Revision } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { invalid, missing, conflict, money, type SalesQuery, type SessionsQuery, type ProductsQuery } from "./schema.js"
import { priceFor } from "./pricing.js"

export type Context = AuthorizedContext
export function rights(c: Context) {
  return { tenantId: c.tenantId, canEdit: c.permissions.includes("sales.pos.manage"), canClose: c.permissions.includes("sales.pos.close"), canCancel: c.permissions.includes("sales.pos.cancel") }
}

const sessionFields = `id,register,cash_account_id AS "cashAccountId",(opening_cents::numeric/100)::numeric(16,2)::text AS "openingAmount",status,revision,opened_at AS "openedAt",closed_at AS "closedAt"`
const saleFields = `id,session_id AS "sessionId",status,revision,(total_cents::numeric/100)::numeric(16,2)::text AS total,created_at AS "createdAt",cancelled_at AS "cancelledAt"`

export async function sessions(c: Context, q: SessionsQuery) {
  if (q.startDate && q.endDate && q.startDate > q.endDate) invalid("Intervalo de datas inválido")
  const row = (await c.client.query(`
    WITH filtered AS (SELECT ${sessionFields} FROM pos_sessions WHERE tenant_id=$1
      AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR lower(register)=lower($3))
      AND ($4::date IS NULL OR opened_at>=($4::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
      AND ($5::date IS NULL OR opened_at<(($5::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))),
    page AS (SELECT * FROM filtered ORDER BY "openedAt" DESC,id DESC LIMIT $6 OFFSET $7)
    SELECT (SELECT count(*) FROM filtered) AS total,COALESCE((SELECT jsonb_agg(page ORDER BY "openedAt" DESC,id DESC) FROM page),'[]') AS data`,
    [c.tenantId,q.status,q.register,q.startDate,q.endDate,q.limit,q.offset])).rows[0]!
  return { ...rights(c), data: row.data, total: revisionValue(row.total), offset: q.offset, limit: q.limit }
}
export async function sales(c: Context, q: SalesQuery) {
  const row = (await c.client.query(`WITH filtered AS (SELECT ${saleFields} FROM pos_sales WHERE tenant_id=$1 AND ($2::uuid IS NULL OR session_id=$2) AND ($3::text IS NULL OR status=$3)),
    page AS (SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT $4 OFFSET $5)
    SELECT (SELECT count(*) FROM filtered) AS total,COALESCE((SELECT jsonb_agg(page ORDER BY "createdAt" DESC,id DESC) FROM page),'[]') AS data`,
    [c.tenantId,q.sessionId,q.status,q.limit,q.offset])).rows[0]!
  return { ...rights(c), data: row.data, total: revisionValue(row.total), offset: q.offset, limit: q.limit }
}
export async function sessionDetail(c: Context, id: string) {
  const args = [c.tenantId,id]
  // A shared session lock gives every dependent query the same ledger revision.
  const header = (await c.client.query(`SELECT ${sessionFields},opened_by AS "openedBy",close_reason AS "closeReason", opening_cents,counted_cents FROM pos_sessions WHERE tenant_id=$1 AND id=$2 FOR SHARE`, args)).rows[0] ?? missing()
  const { opening_cents, counted_cents, ...summary } = header
  const payments = await c.client.query(`SELECT method,COALESCE(sum(amount_cents) FILTER(WHERE s.status='completed'),0) AS net,COALESCE(sum(amount_cents) FILTER(WHERE s.status='cancelled'),0) AS refunded FROM pos_payments p JOIN pos_sales s ON s.tenant_id=p.tenant_id AND s.id=p.sale_id WHERE s.tenant_id=$1 AND s.session_id=$2 GROUP BY method`, args)
  const totals: Record<string,string|null> = { cash:"0.00",pix:"0.00",debit:"0.00",credit:"0.00",refunds:"0.00" }
  let cash = 0n
  for (const p of payments.rows) {
    const net = BigInt(String(p.net))
    totals[String(p.method)] = money(net)
    if (p.method === "cash") { cash = net; totals.refunds = money(BigInt(String(p.refunded))) }
  }
  const movements = (await c.client.query(`SELECT COALESCE(sum(amount_cents) FILTER(WHERE direction='supply'),0) AS supplies,COALESCE(sum(amount_cents) FILTER(WHERE direction='withdrawal'),0) AS withdrawals,count(*) AS count FROM pos_cash_movements WHERE tenant_id=$1 AND session_id=$2`,args)).rows[0]!
  const supplies = BigInt(String(movements.supplies)), withdrawals = BigInt(String(movements.withdrawals))
  const expected = BigInt(String(opening_cents)) + cash + supplies - withdrawals
  const counted = counted_cents === null ? null : BigInt(String(counted_cents))
  Object.assign(totals,{ supplies: money(supplies), withdrawals: money(withdrawals), expectedCash: money(expected), countedCash: counted === null ? null : money(counted), difference: counted === null ? null : money(counted-expected) })
  const recent = await sales(c,{sessionId:id,offset:0,limit:50})
  const entries = await c.client.query(`SELECT id,direction,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,reason,created_at AS "createdAt" FROM pos_cash_movements WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50`,args)
  return { ...summary, id, revision:revisionValue(header.revision), totals, countedCash:totals.countedCash, sales:recent.data, salesTotal:recent.total, movements:entries.rows, movementsTotal:revisionValue(movements.count), recentLimit:50 }
}
export async function current(c: Context, register?: string) {
  const row = (await c.client.query("SELECT id FROM pos_sessions WHERE tenant_id=$1 AND status='open' AND ($2::text IS NULL OR lower(register)=lower($2)) ORDER BY opened_at DESC,id DESC LIMIT 1 FOR SHARE",[c.tenantId,register])).rows[0]
  return { ...rights(c), data: row ? await sessionDetail(c,String(row.id)) : null }
}
export async function saleDetail(c: Context, id: string) {
  const ref = (await c.client.query("SELECT session_id FROM pos_sales WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])).rows[0] ?? missing()
  const session = await sessionDetail(c,String(ref.session_id))
  const row = (await c.client.query(`SELECT ${saleFields},cancel_reason AS "cancelReason",receipt FROM pos_sales WHERE tenant_id=$1 AND id=$2`,[c.tenantId,id])).rows[0] ?? missing()
  const { receipt, ...fields } = row
  return { ...rights(c), data: { ...(receipt as Record<string,unknown>), ...fields, id, revision:revisionValue(row.revision) }, session }
}
export async function lockSession(c: Context, id: string, expected: Revision) {
  const row = (await c.client.query("SELECT status,revision,cash_account_id FROM pos_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[c.tenantId,id])).rows[0] ?? missing()
  if (revisionValue(row.revision) !== expected) throw new Problem(412,"revision_conflict","Outra pessoa alterou o caixa. Atualize os dados")
  if (row.status !== "open") conflict("Caixa fechado não aceita alterações")
  return String(row.cash_account_id)
}
export const reservedSql = `SELECT COALESCE(sum(l.quantity_micros-order_line_delivered(l.tenant_id,l.order_id,l.line_number)),0) FROM sales_order_lines l JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND o.status='confirmed'`
export async function products(c: Context, q: ProductsQuery) {
  const where = `WHERE p.tenant_id=$1 AND p.status='active' AND ($2='' OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%')`
  const args = [c.tenantId,q.search]
  const rows = await c.client.query(`SELECT p.id,p.name,p.sku,p.unit,p.price_cents,GREATEST(COALESCE(b.quantity_micros,0)-(${reservedSql}),0) AS available FROM products p LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id ${where} ORDER BY p.name,p.id LIMIT $3 OFFSET $4`, [...args,q.limit,q.offset])
  const total = (await c.client.query(`SELECT count(*) AS total FROM products p ${where}`,args)).rows[0]!
  const data = []
  for (const row of rows.rows) {
    const item = { id:String(row.id),sku:row.sku,name:row.name,unit:row.unit,available:decimal(BigInt(String(row.available)),6) }
    try {
      const quote = await priceFor(c,item.id,BigInt(String(row.price_cents)),1000000n,q.destination,q.taxpayer)
      data.push({ ...item, unitPrice:money(quote.unit),pricingAvailable:quote.unit>0n })
    } catch(error) {
      if (!(error instanceof Problem) || ![404,409,422].includes(error.status)) throw error
      data.push({ ...item, unitPrice:null, pricingAvailable:false, pricingError:error.message })
    }
  }
  return { ...rights(c),data,total:revisionValue(total.total),offset:q.offset,limit:q.limit }
}
