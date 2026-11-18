import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { decimal, fixed } from "../sales/fixed.js"
import { salesMailDocument } from "../sales/mail-document.js"
import { commissionTerms } from "./commission-ledger.js"
import { missing, orderHead, orderId, stale } from "./supporting-documents.js"

const rate=z.string().refine(v=>/^(0|[1-9][0-9]{0,2})\.[0-9]{4}$/.test(v)&&fixed(v,4)<=1000000n)
const termsInput=z.strictObject({sellerStaffId:z.guid().toLowerCase(),commissionRate:rate,ipiRate:rate,paymentDay:z.number().int().min(1).max(28)})
async function snapshot(c:AuthorizedContext,id:string) {
  const head=await orderHead(c,id,true), t=await commissionTerms(c,id),locked=head.status!=="draft"
  return {tenantId:c.tenantId,canEdit:!locked&&["finance.commissions.manage","sales.orders.manage"].every(p=>c.permissions.includes(p)),data:{orderId:id,revision:revisionValue(head.revision),
    status:t?"configured":"not_required",locked,sellerStaffId:t?.seller_staff_id??null,sellerName:t?.seller_name??null,commissionRate:t?decimal(BigInt(t.commission_rate),4):null,ipiRate:t?decimal(BigInt(t.ipi_rate),4):null,paymentDay:t?.payment_day??null}}
}
export function registerOrderCommercialDocuments(app:FastifyInstance,deps:AccessDependencies) {
  app.get<{Params:{id:string}}>("/api/v1/orders/:id/document",async(req,reply)=>{
    const wanted=parseRevision(req.headers["if-match"]),id=orderId(req.params.id)
    const file=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read")
      if(revisionValue((await orderHead(c,id,true)).revision)!==wanted) throw stale()
      return (await salesMailDocument(c,"order",id)).attachment
    })
    return reply.type(file.contentType).header("content-disposition",'attachment; filename="'+file.filename+'"').header("etag",'"'+wanted+'"').header("cache-control","no-store").header("x-content-type-options","nosniff").send(file.content)
  })
  app.get<{Params:{id:string}}>("/api/v1/orders/:id/commission",async(req,reply)=>{
    const body=await authorizeRequest(req,deps,async c=>{requirePermission(c,"finance.commissions.read");return snapshot(c,orderId(req.params.id))})
    return reply.header("cache-control","no-store").header("etag",'"'+body.data.revision+'"').send(body)
  })
  app.put<{Params:{id:string}}>("/api/v1/orders/:id/commission",async(req,reply)=>{
    const id=orderId(req.params.id), revision=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"])
    const body=await authorizeRequest(req,deps,async c=>{
      for(const p of ["finance.commissions.read","finance.commissions.manage","sales.orders.manage"]) requirePermission(c,p)
      const parsed=termsInput.safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Confira vendedor, alíquotas e dia de pagamento")
      const input=parsed.data, payload={id,revision,input}, prior=await replay(c,key,"commission.configure",payload)
      if(prior) return prior as Awaited<ReturnType<typeof snapshot>>
      const head=await orderHead(c,id,true)
      if(revisionValue(head.revision)!==revision) throw stale()
      const paid=await c.client.query("SELECT FROM receivables r JOIN receivable_payments p ON p.tenant_id=r.tenant_id AND p.receivable_id=r.id WHERE r.tenant_id=$1 AND r.order_id=$2 LIMIT 1",[c.tenantId,id])
      if(head.status!=="draft"||paid.rows.length) throw new Problem(409,"domain_conflict","A comissão exige um rascunho sem recebimentos")
      const seller=(await c.client.query("SELECT name,is_seller,status FROM staff WHERE tenant_id=$1 AND id=$2",[c.tenantId,input.sellerStaffId])).rows[0]
      if(!seller) throw missing()
      if(!seller.is_seller||seller.status!=="active") throw new Problem(409,"domain_conflict","Selecione um vendedor ativo")
      const next=nextRevision(revision)
      await c.client.query(`INSERT INTO order_commission_terms(tenant_id,order_id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,order_id) DO UPDATE SET seller_staff_id=EXCLUDED.seller_staff_id,seller_name=EXCLUDED.seller_name,commission_rate=EXCLUDED.commission_rate,ipi_rate=EXCLUDED.ipi_rate,payment_day=EXCLUDED.payment_day`,[c.tenantId,id,input.sellerStaffId,seller.name,fixed(input.commissionRate,4),fixed(input.ipiRate,4),input.paymentDay])
      await c.client.query("INSERT INTO commission_accounts(tenant_id,seller_staff_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[c.tenantId,input.sellerStaffId])
      await c.client.query("UPDATE sales_orders SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,next])
      await record(c,req.headers,"sales_order",id,"commission.configured",{previousRevision:revision,revision:next,...input})
      const result=await snapshot(c,id)
      await remember(c,key,"commission.configure",payload,result)
      return result
    })
    return reply.header("cache-control","no-store").header("etag",'"'+body.data.revision+'"').send(body)
  })
}
