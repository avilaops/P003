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
  // Order commission terms are served by finance-management/commissions.ts.
}
