import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { decimal, validateDate } from "../sales/fixed.js"
import { reconcileCancellation, requireCancellationPermissions } from "./cancellation.js"
import { ensureCommissionAccess } from "./commission-ledger.js"
import { titleSnapshots } from "./finance-snapshot.js"
import { reversePayment } from "./settlements.js"
import { orderHead, orderId, stale } from "./supporting-documents.js"
import type { CommandHeaders } from "./receivables.js"

const command=z.strictObject({reason:z.string().refine(v=>v.trim().length>=15&&v.trim().length<=200&&!/\p{Cc}/u.test(v.trim())),occurredOn:z.string().transform(validateDate)})
const conflict=(message:string)=>new Problem(409,"domain_conflict",message)
async function restoreStock(c:AuthorizedContext,headers:CommandHeaders,order:string,reason:string) {
  const movements=await c.client.query<{id:string;product_id:string;quantity_micros:string}>(`SELECT m.id,m.product_id,m.quantity_micros FROM stock_movements m
    WHERE m.tenant_id=$1 AND m.source_order_id=$2 AND m.direction='issue' AND m.reverses_id IS NULL AND NOT EXISTS(SELECT FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) ORDER BY m.product_id,m.id`,[c.tenantId,order])
  const totals=await c.client.query<{product_id:string;quantity:string}>("SELECT product_id,sum(quantity_micros)::text AS quantity FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2 GROUP BY product_id ORDER BY product_id",[c.tenantId,order])
  const issued=new Map<string,bigint>()
  for(const m of movements.rows) issued.set(m.product_id,(issued.get(m.product_id)??0n)+BigInt(m.quantity_micros))
  if(!issued.size||issued.size!==totals.rows.length||totals.rows.some(p=>issued.get(p.product_id)!==BigInt(p.quantity))) throw conflict("Os movimentos de saída não conciliam com os itens do pedido")
  const ids:string[]=[]
  for(const m of movements.rows) {
    const row=(await c.client.query<{quantity_micros:string}>(`UPDATE stock_balances SET quantity_micros=quantity_micros+$3::bigint WHERE tenant_id=$1 AND product_id=$2
      AND quantity_micros<=999999999999999999-$3::bigint RETURNING quantity_micros`,[c.tenantId,m.product_id,m.quantity_micros])).rows[0]
    if(!row) throw conflict("Saldo físico indisponível ou superior ao limite")
    const id=randomUUID()
    await c.client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id) VALUES($1,$2,$3,'receipt',$4,$5,$6,$7)",[id,c.tenantId,m.product_id,m.quantity_micros,row.quantity_micros,reason,m.id])
    await record(c,headers,"stock_movement",id,"stock.moved",{sourceId:order,productId:m.product_id,direction:"receipt",quantity:decimal(BigInt(m.quantity_micros),6),balanceAfter:decimal(BigInt(row.quantity_micros),6),reversesId:m.id,reason})
    ids.push(id)
  }
  return ids
}
export function registerCompletedCancellation(app:FastifyInstance,deps:AccessDependencies) {
  app.get<{Params:{id:string}}>("/api/v1/orders/:id/cancellations",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read")
      const id=orderId(req.params.id)
      await orderHead(c,id)
      const rows=await c.client.query("SELECT summary FROM sales_order_cancellations WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id",[c.tenantId,id])
      return {tenantId:c.tenantId,data:rows.rows.map(r=>r.summary)}
    })
    return reply.header("cache-control","no-store").send(result)
  })
  app.post<{Params:{id:string}}>("/api/v1/orders/:id/cancel-completed",async(req,reply)=>{
    const id=orderId(req.params.id),revision=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"])
    const result=await authorizeRequest(req,deps,async c=>{
      for(const permission of ["sales.orders.read","sales.orders.manage","inventory.stock.manage","finance.receivables.manage"]) requirePermission(c,permission)
      await ensureCommissionAccess(c,id);await requireCancellationPermissions(c,id)
      const parsed=command.safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Informe a data e um motivo de 15 a 200 caracteres")
      const input=parsed.data, bodySha256=createHash("sha256").update(JSON.stringify({reason:input.reason,occurredOn:input.occurredOn})).digest("hex")
      const payload={id,revision,bodySha256,input},scope="sales.order.cancelled_completed",prior=await replay(c,key,scope,payload)
      if(prior) return prior
      const head=await orderHead(c,id,true)
      if(revisionValue(head.revision)!==revision) throw stale()
      if(head.status!=="completed") throw conflict("O cancelamento integral exige uma venda concluída")
      const lots=await c.client.query(`SELECT FROM sales_invoice_lots l LEFT JOIN fiscal_nfe_documents d ON d.tenant_id=l.tenant_id AND d.id=l.draft_id
        WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.environment='production' AND (NOT l.legacy_full OR EXISTS(SELECT FROM sales_partial_returns r WHERE r.tenant_id=l.tenant_id AND r.lot_id=l.id))
        AND (l.delivered_at IS NOT NULL OR NOT l.withdrawn AND coalesce(d.status,'draft') NOT IN ('rejected','cancelled')) LIMIT 1`,[c.tenantId,id])
      if(lots.rows.length) throw conflict("Concilie os lotes fiscais e as devoluções por item antes de cancelar integralmente")
      const reason=input.reason.trim(), titles=await titleSnapshots(c,{order:id})
      if(!titles.length||titles.some(t=>t.data.status==="cancelled")||titles.reduce((n,t)=>n+BigInt(t.data.amount.replace(".","")),0n)!==BigInt(head.amount_cents)) throw conflict("Concilie os títulos da venda antes do cancelamento integral")
      const stockMovementIds=await restoreStock(c,req.headers,id,reason), paymentReversalIds:string[]=[]
      for(const title of titles) {
        for(const p of title.payments.filter(p=>p.kind==="receipt"&&!title.payments.some(r=>r.reversesId===p.id))) {
          paymentReversalIds.push(await reversePayment(c,req.headers,title,{paymentId:p.id,reason,occurredOn:input.occurredOn},true))
        }
        const next=nextRevision(title.data.revision)
        await c.client.query("UPDATE receivables SET status='cancelled',payment_id=NULL,revision=$3 WHERE tenant_id=$1 AND id=$2",[c.tenantId,title.data.id,next])
        await record(c,req.headers,"receivable",title.data.id,"receivable.cancelled",{sourceId:id,reason,previousRevision:title.data.revision,revision:next,status:"cancelled",outstandingAmount:"0.00"})
      }
      const next=nextRevision(revision), data=await reconcileCancellation(c,req.headers,id,next,{reason,occurred:input.occurredOn,receivableIds:titles.map(t=>t.data.id),stockMovementIds,paymentReversalIds})
      await c.client.query("UPDATE sales_orders SET status='cancelled',revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,next])
      await record(c,req.headers,"sales_order",id,scope,data)
      const body={tenantId:c.tenantId,data}
      await remember(c,key,scope,payload,body)
      return body
    })
    return reply.header("cache-control","no-store").header("etag",'"'+(result.data as {revision:number}).revision+'"').send(result)
  })
}
