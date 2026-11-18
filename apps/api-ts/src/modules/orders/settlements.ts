import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { nextRevision, parseRevision } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"
import { getTitle, orderFinance } from "./finance-snapshot.js"
import { postCommission } from "./commission-ledger.js"
import { missing, orderId, prepareDocument, saveDocument, stale, supportingInput, uploadLimit } from "./supporting-documents.js"
import type { CommandHeaders } from "./receivables.js"

const reference=z.string().trim().min(3).max(200).refine(v=>!/\p{Cc}/u.test(v))
const payment=z.strictObject({amount:z.string(),method:z.enum(["cash","bank_transfer","card","other"]),reference,occurredOn:z.string().transform(validateDate),financialAccountId:z.guid().toLowerCase().nullish(),paymentMethodId:z.guid().toLowerCase().nullish(),supportingDocument:supportingInput.nullish()})
const reversal=z.strictObject({paymentId:z.guid().toLowerCase(),reason:reference,occurredOn:z.string().transform(validateDate)})
type Title=Awaited<ReturnType<typeof getTitle>>
const conflict=(m:string)=>new Problem(409,"domain_conflict",m)
async function bank(c:AuthorizedContext,account:string|null,reverse:boolean,amount:bigint,occurred:string,ref:string) {
  if(!account) return
  const state=(await c.client.query("SELECT status,EXISTS(SELECT 1 FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open') AS managed FROM financial_accounts WHERE tenant_id=$1 AND id=$2",[c.tenantId,account])).rows[0]
  if(!state) throw missing()
  if(state.managed||!reverse&&state.status!=="active") throw conflict("A conta está arquivada ou vinculada a um caixa PDV aberto")
  await c.client.query("INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(),c.tenantId,account,reverse?"debit":"credit",amount,occurred,reverse?"Estorno de lançamento financeiro":"Recebimento declarado",ref])
}
export async function reversePayment(c:AuthorizedContext,headers:CommandHeaders,title:Title,input:z.infer<typeof reversal>, commercialCancellation=false) {
  const {data,payments}=title, original=payments.find(p=>p.id===input.paymentId&&p.kind==="receipt")
  if(data.status==="cancelled"||!original||payments.some(p=>p.reversesId===input.paymentId)) throw conflict("Selecione um recebimento ativo deste título")
  if(input.occurredOn<original.occurredOn) throw new Problem(422,"invalid_input","A data do estorno antecede o recebimento")
  const id=randomUUID(),amount=fixed(original.amount,2),next=nextRevision(data.revision)
  if(amount>BigInt(data.receivedAmount.replace(".",""))) throw conflict("Concilie o saldo recebido antes do estorno")
  await bank(c,original.financialAccountId,true,amount,input.occurredOn,input.reason)
  await c.client.query(`INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on,financial_account_id,reverses_id,payment_method_id,payment_method)
    VALUES($1,$2,$3,'reversal',$4,$5,$6,$7,$8,$9,$10,$11)`,[id,c.tenantId,data.id,amount,original.method,input.reason,input.occurredOn,original.financialAccountId,original.id,original.paymentMethodId,original.paymentMethod])
  await postCommission(c,headers,data.orderId,id,amount,input.occurredOn,input.reason,original.id)
  if (!commercialCancellation) await c.client.query("UPDATE receivables SET status='open',payment_id=NULL,revision=$3 WHERE tenant_id=$1 AND id=$2",[c.tenantId,data.id,next])
  await record(c,headers,"receivable",data.id,"receivable.payment_reversed",{paymentId:id,reversesId:original.id,
    ...(commercialCancellation ? {amount:original.amount,source:"commercial_return",bankTransferExecuted:false} : {previousRevision:data.revision,revision:next})})
  return id
}
async function pay(c:AuthorizedContext,headers:CommandHeaders,title:Title,input:z.infer<typeof payment>,doc:ReturnType<typeof prepareDocument>|null) {
  const {data}=title, id=randomUUID(), amount=fixed(input.amount,2)
  if(amount<=0n) throw new Problem(422,"invalid_input","O recebimento deve ser positivo")
  if(data.status!=="open"||amount>BigInt(data.outstandingAmount.replace(".",""))) throw conflict("Valor superior ao saldo de um título em aberto")
  const remaining=fixed(data.outstandingAmount,2)-amount, next=nextRevision(data.revision)
  const method=input.paymentMethodId?(await c.client.query<{id:string;code:string;name:string;modality:string}>("SELECT id,code,name,modality FROM payment_methods WHERE tenant_id=$1 AND id=$2 AND status='active'",[c.tenantId,input.paymentMethodId])).rows[0]:null
  if(input.paymentMethodId&&!method) throw missing()
  const category=method?({pix:"bank_transfer",bank_transfer:"bank_transfer",credit_card:"card",debit_card:"card",cash:"cash"} as Record<string,string>)[method.modality]??"other":input.method
  await bank(c,input.financialAccountId??null,false,amount,input.occurredOn,input.reference)
  await c.client.query(`INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on,financial_account_id,payment_method_id,payment_method)
    VALUES($1,$2,$3,'receipt',$4,$5,$6,$7,$8,$9,$10)`,[id,c.tenantId,data.id,amount,category,input.reference,input.occurredOn,input.financialAccountId??null,method?.id??null,method??null])
  if(doc) await saveDocument(c,headers,data.orderId,id,doc)
  await postCommission(c,headers,data.orderId,id,amount,input.occurredOn,input.reference,null)
  await c.client.query("UPDATE receivables SET status=$3,payment_id=$4,revision=$5 WHERE tenant_id=$1 AND id=$2",[c.tenantId,data.id,remaining?"open":"paid",remaining?null:id,next])
  await record(c,headers,"receivable",data.id,remaining?"receivable.payment_recorded":"receivable.paid",{paymentId:id,amount:decimal(amount,2),outstandingAmount:decimal(remaining,2),previousRevision:data.revision,revision:next,source:"manual_declaration"})
}

export function registerOrderFinance(app:FastifyInstance,deps:AccessDependencies) {
  app.get<{Params:{id:string}}>("/api/v1/orders/:id/finance",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{requirePermission(c,"finance.receivables.read");return orderFinance(c,orderId(req.params.id))})
    return reply.header("cache-control","no-store").send(result)
  })
  app.get<{Params:{id:string}}>("/api/v1/receivables/:id",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{requirePermission(c,"finance.receivables.read");return getTitle(c,orderId(req.params.id))})
    return reply.header("cache-control","no-store").header("etag",'"'+result.data.revision+'"').send(result)
  })
  for(const action of ["payments","reverse-payment"] as const) {
    app.post<{Params:{id:string}}>("/api/v1/receivables/:id/"+action,{bodyLimit:uploadLimit},async(req,reply)=>{
      const id=orderId(req.params.id), key=commandKey(req.headers["idempotency-key"]), revision=parseRevision(req.headers["if-match"])
      const result=await authorizeRequest(req,deps,async c=>{
        requirePermission(c,"finance.receivables.read");requirePermission(c,"finance.receivables.manage")
        const parsed=(action==="payments"?payment:reversal).safeParse(req.body)
        if(!parsed.success) throw new Problem(422,"invalid_input","Dados do recebimento ou do estorno inválidos")
        const v=parsed.data, doc="supportingDocument" in v&&v.supportingDocument?prepareDocument(v.supportingDocument):null
        const input="amount" in v?{amount:v.amount,method:v.method,reference:v.reference,occurredOn:v.occurredOn,financialAccountId:v.financialAccountId??null,paymentMethodId:v.paymentMethodId??null,...(doc?{supportingDocument:doc.metadata}:{})}:v
        const scope=action==="payments"?"receivable.pay":"receivable.reverse", payload={id,revision,input}
        const prior=await replay(c,key,scope,payload)
        if(prior) return prior as Title
        const title=await getTitle(c,id)
        if(title.data.revision!==revision) throw stale()
        if("amount" in v) await pay(c,req.headers,title,v,doc)
        else await reversePayment(c,req.headers,title,v)
        const body=await getTitle(c,id)
        await remember(c,key,scope,payload,body)
        return body
      })
      return reply.header("etag",'"'+result.data.revision+'"').header("cache-control","no-store").send(result)
    })
  }
}
