import {z} from "zod"
import type {AuthorizedContext} from "../../platform/access.js"
import {Problem} from "../../platform/problem.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import {validateDate} from "../sales/fixed.js"

export const termReference=z.strictObject({id:normalizedDatabaseId,revision:z.number().int().positive(),start:z.iso.date()})
export type TermReference=z.infer<typeof termReference>
export type FrozenTerm={id:string;revision:number;name:string;entryBps:number;days:number[];methodId:string;start:string}
export function paymentSchedule(total:bigint,term:FrozenTerm){
 if(total<=0n || total>99999999999999n) throw new Problem(422,"invalid_input","Valor do pedido fora do limite")
 const entry=(total*BigInt(term.entryBps)+5000n)/10000n,balance=total-entry,n=BigInt(term.days.length)
 if((balance>0n && (n===0n||balance<n))||(balance===0n&&n>0n)) throw new Problem(422,"invalid_input","Quantidade de parcelas incompatível com o saldo")
 const start=validateDate(term.start)
 const installments=term.days.map((days,index)=>{
  const date=new Date(start+"T12:00:00Z")
  date.setUTCDate(date.getUTCDate()+days)
  const dueOn=validateDate(date.toISOString().slice(0,10))
  return {dueOn,paymentMethodId:term.methodId,amountCents:Number(balance/n+(BigInt(index)<balance%n?1n:0n))}
 })
 return {entryCents:Number(entry),entry:{dueOn:start,paymentMethodId:entry>0n?term.methodId:null},installments}
}
type PostedPlan = {entry:{dueOn:string|null;paymentMethodId:string|null};installments:{dueOn:string;paymentMethodId:string;amountCents:number|string|bigint}[]}
export function verifyPaymentTerm(total:bigint, entry:bigint, term:FrozenTerm, input:PostedPlan) {
 const plan=paymentSchedule(total,term)
 if (entry!==BigInt(plan.entryCents) || (entry>0n && (input.entry.dueOn!==plan.entry.dueOn || input.entry.paymentMethodId!==plan.entry.paymentMethodId)) || plan.installments.length!==input.installments.length || input.installments.some((item,index)=>{
   const agreed=plan.installments[index]!
   return item.dueOn!==agreed.dueOn || item.paymentMethodId!==agreed.paymentMethodId || BigInt(item.amountCents)!==BigInt(agreed.amountCents)
 })) throw new Problem(409,"domain_conflict","Os valores ou vencimentos divergem da condição escolhida. Aplique novamente a condição")
}
export async function loadTerm(context:AuthorizedContext,input:TermReference):Promise<FrozenTerm>{
 const {rows}=await context.client.query<{id:string;revision:number;name:string;entryBps:number;days:number[];methodId:string}>('SELECT t.id,t.revision::int,t.name,t.entry_bps AS "entryBps",t.due_days AS days,t.method_id AS "methodId" FROM sales_payment_terms t JOIN payment_methods m ON m.tenant_id=t.tenant_id AND m.id=t.method_id WHERE t.tenant_id=$1 AND t.id=$2 AND t.active AND m.status=\'active\'',[context.tenantId,input.id])
 const term=rows[0]
 if(!term || term.revision!==input.revision) throw new Problem(412,"revision_conflict","A condição de pagamento mudou. Confira os vencimentos e aplique novamente")
 return {...term,start:input.start}
}
