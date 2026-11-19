import { randomUUID } from "node:crypto"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import type { CommandHeaders } from "./receivables.js"
import { decimal } from "../sales/fixed.js"

export async function commissionTerms(c:AuthorizedContext,order:string) {
  return (await c.client.query<{seller_staff_id:string;seller_name:string;commission_rate:string;ipi_rate:string;payment_day:number}>(
    "SELECT seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day FROM order_commission_terms WHERE tenant_id=$1 AND order_id=$2",[c.tenantId,order])).rows[0]
}
export async function ensureCommissionAccess(c:AuthorizedContext,order:string) {
  const required=(await c.client.query("SELECT EXISTS(SELECT 1 FROM order_commission_terms WHERE tenant_id=$1 AND order_id=$2 UNION ALL SELECT 1 FROM commission_entries WHERE tenant_id=$1 AND order_id=$2) AS needed",[c.tenantId,order])).rows[0]!.needed
  if(required) {requirePermission(c,"finance.commissions.read"); requirePermission(c,"finance.commissions.manage")}
}
export async function postCommission(c:AuthorizedContext,headers:CommandHeaders,order:string,payment:string,amount:bigint,occurred:string,reference:string,original:string|null) {
  const fields=original?(await c.client.query<{seller_staff_id:string;seller_name:string;commission_rate:string;ipi_rate:string;payment_day:number;id:string;amount_cents:string;base_cents:string}>(
    "SELECT id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day,amount_cents,base_cents FROM commission_entries WHERE tenant_id=$1 AND order_id=$2 AND kind='receipt' AND receipt_id=$3",[c.tenantId,order,original])).rows[0]:undefined
  const terms=fields??await commissionTerms(c,order)
  if(!terms) return
  if(original&&!fields) throw new Problem(409,"domain_conflict","Concilie a comissão do recebimento original antes de estornar")
  const denominator=1000000n+BigInt(terms.ipi_rate)
  const base=fields?-BigInt(fields.base_cents):(amount*1000000n+denominator/2n)/denominator
  const value=fields?-BigInt(fields.amount_cents):(amount*BigInt(terms.commission_rate)+denominator/2n)/denominator
  if(occurred>="2100-12-01") throw new Problem(422,"invalid_input","Vencimento da comissão fora do intervalo permitido")
  const id=randomUUID(), seller=terms.seller_staff_id
  await c.client.query("INSERT INTO commission_accounts(tenant_id,seller_staff_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[c.tenantId,seller])
  const periods=(await c.client.query(`INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,order_id,kind,receipt_id,reversal_id,reverses_entry_id,competence,payment_due,base_cents,commission_rate,ipi_rate,payment_day,amount_cents,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,date_trunc('month',$10::date)::date,(date_trunc('month',$10::date)+interval '1 month')::date + ($11::int-1),$12,$13,$14,$11,$15,$16) RETURNING competence::text,payment_due::text`,
  [id,c.tenantId,seller,terms.seller_name,order,original?"reversal":"receipt",original?null:payment,original?payment:null,fields?.id??null,occurred,terms.payment_day,base,terms.commission_rate,terms.ipi_rate,value,original?reference:"Comissão sobre recebimento"])).rows[0]!
  await c.client.query("UPDATE commission_accounts SET revision=revision+1 WHERE tenant_id=$1 AND seller_staff_id=$2",[c.tenantId,seller])
  const details=original?{orderId:order,reversalId:payment,reversesEntryId:fields!.id,sellerStaffId:seller,amount:(value<0n?"-":"")+decimal(-value,2),originalPaymentPreserved:true}
    :{orderId:order,receiptId:payment,sellerStaffId:seller,amount:decimal(value,2),baseAmount:decimal(base,2),competence:periods.competence,paymentDue:periods.payment_due}
  await record(c,headers,"commission",id,original?"commission.reversed":"commission.accrued",details)
}
