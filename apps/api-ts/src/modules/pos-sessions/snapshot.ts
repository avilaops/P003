import { revisionValue } from "../../platform/revision.js"
import { missing, money } from "../finance-treasury/ledger.js"
import type { AuthorizedContext } from "../../platform/access.js"

export const summary = `s.id,s.register,s.cash_account_id AS "cashAccountId",round(s.opening_cents/100.0,2)::text AS "openingAmount",
  s.status,s.revision,s.opened_at AS "openedAt",s.closed_at AS "closedAt"`
const numbers = `LEFT JOIN LATERAL (
  SELECT coalesce(sum(p.amount_cents) FILTER(WHERE v.status='completed' AND p.method='cash'),0) AS cash,
    coalesce(sum(p.amount_cents) FILTER(WHERE v.status='completed' AND p.method='pix'),0) AS pix,
    coalesce(sum(p.amount_cents) FILTER(WHERE v.status='completed' AND p.method='debit'),0) AS debit,
    coalesce(sum(p.amount_cents) FILTER(WHERE v.status='completed' AND p.method='credit'),0) AS credit,
    coalesce(sum(p.amount_cents) FILTER(WHERE v.status='cancelled' AND p.method='cash'),0) AS refunds
  FROM pos_sales v JOIN pos_payments p ON p.tenant_id=v.tenant_id AND p.sale_id=v.id
  WHERE v.tenant_id=s.tenant_id AND v.session_id=s.id) payments ON true
  LEFT JOIN LATERAL (SELECT coalesce(sum(amount_cents) FILTER(WHERE direction='supply'),0) AS supplies,
    coalesce(sum(amount_cents) FILTER(WHERE direction='withdrawal'),0) AS withdrawals FROM pos_cash_movements m
    WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id) moved ON true`
const expected = "s.opening_cents+payments.cash+moved.supplies-moved.withdrawals"
export async function expectedCash(c: AuthorizedContext, id: string) {
  const row = (
    await c.client.query(
      `SELECT ${expected} AS amount FROM pos_sessions s ${numbers} WHERE s.tenant_id=$1 AND s.id=$2`,
      [c.tenantId, id],
    )
  ).rows[0]
  if (!row) throw missing()
  return BigInt(String(row.amount))
}
export async function detail(c: AuthorizedContext, id: string) {
  const row = (
    await c.client.query(
      `SELECT ${summary},s.opened_by AS "openedBy",s.close_reason AS "closeReason",s.counted_cents AS counted,
    payments.*,moved.*,(${expected}) AS expected,
    (SELECT count(*)::int FROM pos_sales WHERE tenant_id=s.tenant_id AND session_id=s.id) AS "salesTotal",
    (SELECT count(*)::int FROM pos_cash_movements WHERE tenant_id=s.tenant_id AND session_id=s.id) AS "movementsTotal",
    coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v."createdAt" DESC,v.id DESC) FROM (
      SELECT v.id,v.session_id AS "sessionId",v.status,round(v.total_cents/100.0,2)::text AS total,v.revision,v.created_at AS "createdAt"
      FROM pos_sales v WHERE v.tenant_id=s.tenant_id AND v.session_id=s.id ORDER BY v.created_at DESC,v.id DESC LIMIT 50
    ) v),'[]') AS sales,
    coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."createdAt" DESC,m.id DESC) FROM (
      SELECT m.id,m.direction,round(m.amount_cents/100.0,2)::text AS amount,m.reason,m.created_at AS "createdAt",
        m.transfer_id AS "transferId",m.reverses_movement_id AS "reversesMovementId",
        EXISTS(SELECT 1 FROM pos_cash_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_movement_id=m.id) AS reversed
      FROM pos_cash_movements m WHERE m.tenant_id=s.tenant_id AND m.session_id=s.id ORDER BY m.created_at DESC,m.id DESC LIMIT 50
    ) m),'[]') AS movements
    FROM pos_sessions s ${numbers} WHERE s.tenant_id=$1 AND s.id=$2`,
      [c.tenantId, id],
    )
  ).rows[0]
  if (!row) throw missing()
  const { counted, expected: expectedValue, cash, pix, debit, credit, refunds, supplies, withdrawals, ...data } = row
  const countedCash = counted === null ? null : money(String(counted))
  return {
    ...data,
    revision: revisionValue(row.revision),
    recentLimit: 50,
    countedCash,
    totals: {
      cash: money(String(cash)),
      pix: money(String(pix)),
      debit: money(String(debit)),
      credit: money(String(credit)),
      refunds: money(String(refunds)),
      supplies: money(String(supplies)),
      withdrawals: money(String(withdrawals)),
      expectedCash: money(String(expectedValue)),
      countedCash,
      difference: counted === null ? null : money(BigInt(String(counted)) - BigInt(String(expectedValue))),
    },
  }
}
