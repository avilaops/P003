import type { AuthorizedContext } from "../../platform/access.js"
import { revisionValue } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { missing, orderHead } from "./supporting-documents.js"

type Payment={id:string;kind:string;amount:string;method:string;reference:string;occurredOn:string;reversesId:string|null;financialAccountId:string|null;paymentMethodId:string|null;paymentMethod:Record<string,unknown>|null}
const cents = (v:string) => BigInt(v.replace(".",""))
const money = (v:bigint) => (v<0n?"-":"")+decimal(v<0n?-v:v,2)
export async function titleSnapshots(c:AuthorizedContext,filter:{order?:string;id?:string}) {
  const rows=await c.client.query<{id:string;order_id:string;customer_name:string;due_date:string;amount_cents:string;status:string;revision:string;payment_id:string|null;order_installment_id:string|null;installment_number:number|null;installment_kind:string|null;planned_payment_method_id:string|null;payments:Payment[];received:string;abated:string}>(`
    SELECT r.id,r.order_id,r.customer_name,r.due_date::text,r.amount_cents,r.status,r.revision,r.payment_id,r.order_installment_id,
      (coalesce((SELECT sum(a.amount_cents) FROM sales_return_abatements a WHERE a.tenant_id=r.tenant_id AND a.receivable_id=r.id),0)
        + coalesce((SELECT sum(a.amount_cents) FROM sales_return_credit_applications a WHERE a.tenant_id=r.tenant_id AND a.receivable_id=r.id),0)
        + coalesce((SELECT sum(a.amount_cents) FROM warranty_settlements a WHERE a.tenant_id=r.tenant_id AND a.receivable_id=r.id AND a.kind='apply_credit'),0))::text AS abated,
      i.number AS installment_number,i.kind AS installment_kind,i.payment_method_id AS planned_payment_method_id,h.payments,h.received
    FROM receivables r LEFT JOIN sales_order_installments i ON i.tenant_id=r.tenant_id AND i.id=r.order_installment_id
    CROSS JOIN LATERAL (SELECT coalesce(sum(CASE WHEN p.kind='receipt' THEN p.amount_cents ELSE -p.amount_cents END),0)::text AS received,
      coalesce(jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'amount',round(p.amount_cents::numeric/100,2)::text,'method',p.method,
      'reference',p.reference,'occurredOn',p.occurred_on,'reversesId',p.reverses_id,'financialAccountId',p.financial_account_id,'paymentMethodId',p.payment_method_id,
      'paymentMethod',p.payment_method) ORDER BY p.created_at,p.id),'[]') AS payments FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id) h
    WHERE r.tenant_id=$1 AND (`+(filter.id?"r.id":"r.order_id")+`=$2) ORDER BY r.due_date,r.id`,[c.tenantId,filter.id??filter.order])
  return rows.rows.map(r=>{
    const amount=BigInt(r.amount_cents),net=BigInt(r.received)
    return {tenantId:c.tenantId,canEdit:c.permissions.includes("finance.receivables.manage"),payments:r.payments,
      data:{id:r.id,orderId:r.order_id,customerName:r.customer_name,dueDate:r.due_date,amount:money(amount),abatedAmount:money(BigInt(r.abated)),receivedAmount:money(net),
        outstandingAmount:money(r.status==="cancelled"?0n:amount-net),status:r.status,revision:revisionValue(r.revision),paymentId:r.payment_id,
        orderInstallmentId:r.order_installment_id,installmentNumber:r.installment_number,installmentKind:r.installment_kind,plannedPaymentMethodId:r.planned_payment_method_id}}
  })
}
export async function getTitle(c:AuthorizedContext,id:string) {
  const row=(await titleSnapshots(c,{id}))[0]
  if(!row) throw missing()
  return row
}
export async function orderFinance(c:AuthorizedContext,order:string) {
  const {status,amount_cents}=await orderHead(c,order,true), receivables=await titleSnapshots(c,{order}), amount=BigInt(amount_cents)
  let title=0n,received=0n,outstanding=0n,abatements=0n,inconsistent=false
  for(const {data} of receivables) {
    const total=cents(data.amount),paid=cents(data.receivedAmount),open=cents(data.outstandingAmount)
    const abated=cents(data.abatedAmount), closedByCredit=data.status==="cancelled"&&abated>0n
    title+=closedByCredit?0n:total; received+=paid; outstanding+=open; abatements+=abated
    inconsistent ||= paid<0n||open<0n||paid>total||data.status==="paid"&&paid!==total||data.status==="open"&&paid>=total||status!=="cancelled"&&data.status==="cancelled"&&!closedByCredit
  }
  const state=status==="cancelled"?"cancelled":!receivables.length?"not_originated":inconsistent||title+abatements!==amount?"inconsistent":!outstanding?(abatements?"settled_with_credit":"paid"):received>0n||abatements>0n?"partial":"open"
  return {tenantId:c.tenantId,orderId:order,orderStatus:status,orderAmount:money(amount),titleAmount:money(title),abatedAmount:money(abatements),receivedAmount:money(received),
    outstandingAmount:money(state==="cancelled"?0n:state==="not_originated"?amount:outstanding),state,canEdit:c.permissions.includes("finance.receivables.manage"),receivables}
}
