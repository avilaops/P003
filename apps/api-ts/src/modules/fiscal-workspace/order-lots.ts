import {ownStart,ownDecision,ownRelease,ownClose,prepareOwnReturn,changeOwnReturn,completeOwnReturn,ownEvidence} from "./self-returns.js"
import {registerSalesReturns} from "./returns-list.js"
import {applyReturnCredit,returnCreditTitles} from "./return-credit.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { parseRevision, nextRevision } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { conflict } from "../orders/acceptance.js"
import { heldQuantity } from "../orders/fulfillment.js"
import type { CommandHeaders } from "../orders/receivables.js"
import { renderDanfe } from "../nfe-email/danfe.js"
import { lotState } from "./order-lot-state.js"
import { verifyReturnDocument } from "./partial-return.js"

import { decideReturn,pendingReturn,registerReturnPolicy,submitReturn } from "./return-policy.js"

const environment=z.enum(["production","homologation"])
const item=z.strictObject({lineNumber:z.number().int().min(1).max(100),quantityMicros:z.string().regex(/^[1-9][0-9]{0,17}$/).refine(v=>BigInt(v)%100n===0n)})
const input=z.discriminatedUnion("action",[
  ownStart,ownDecision,ownRelease,ownClose,
  z.strictObject({action:z.literal("prepare"),environment,items:z.array(item).min(1).max(100)}),
  z.strictObject({action:z.literal("withdraw"),environment,lotId:z.guid()}),
  z.strictObject({action:z.literal("deliver"),environment:z.literal("production"),lotId:z.guid()}),
  z.strictObject({action:z.literal("applyCredit"),environment:z.literal("production"),returnId:z.guid(),receivableId:z.guid(),amountCents:z.string().regex(/^[1-9][0-9]{0,13}$/)}),
  z.strictObject({action:z.literal("decideReturn"),environment:z.literal("production"),requestId:z.guid(),approve:z.boolean(),reason:z.string().trim().min(3).max(200)}),
  z.strictObject({action:z.literal("return"),environment:z.literal("production"),lotId:z.guid(),receivedId:z.string().regex(/^[1-9][0-9]{0,18}$/).refine(i=>BigInt(i)<=9223372036854775807n),
    reason:z.string().trim().min(3).max(200),destination:z.enum(["stock","service","discard"])})
])
function access(c:AuthorizedContext,action?:z.infer<typeof input>["action"]) {
  requirePermission(c,"sales.orders.read")
  requirePermission(c,"fiscal.nfe.read")
  if (!action) return
  requirePermission(c,"sales.orders.manage")
  if (["prepare","withdraw","prepareOwnReturn","decideOwnReturn","completeOwnReturn","releaseOwnReturn"].includes(action)) requirePermission(c,"fiscal.nfe.manage")
  if (action==="decideOwnReturn" && !c.permissions.some(p=>p==="sales.approvals.manage" || p==="sales.approvals.director"))throw new Problem(403,"forbidden","A decisão exige alçada de aprovação")
  if (action==="applyCredit") requirePermission(c,"finance.receivables.manage")
  if (action==="return" || action==="decideReturn" || action==="deliver") requirePermission(c,"inventory.stock.manage")
  if (action==="return" || action==="decideReturn") {
    requirePermission(c,"finance.receivables.manage")
    requirePermission(c,"fiscal.received_nfe.manage")
  }
}

async function deliver(c:AuthorizedContext,headers:CommandHeaders,state:Awaited<ReturnType<typeof lotState>>,lotId:string) {
  const lot=state.lots.find(l=>l.id===lotId)
  if (!lot || lot.status!=="authorized" || lot.deliveredAt || state.status!=="confirmed") conflict("A entrega exige lote autorizado de produção pendente neste pedido confirmado")
  for (const item of lot.items) {
    const line=state.lines.find(l=>l.lineNumber===item.lineNumber)!
    const qty=BigInt(item.quantity)
    if (BigInt(line.delivered)+qty>BigInt(line.ordered)) conflict("A entrega excede a quantidade física do pedido")
    const stock=(await c.client.query(`SELECT b.quantity_micros FROM stock_balances b JOIN products p ON p.tenant_id=b.tenant_id AND p.id=b.product_id
      WHERE b.tenant_id=$1 AND b.product_id=$2 AND p.status='active' AND p.unit=$3 FOR UPDATE OF b`,[c.tenantId,line.productId,line.unit])).rows[0]
    const balance=BigInt(String(stock?.quantity_micros ?? 0)), held=await heldQuantity(c,line.productId)
    if (!stock || held<qty || balance<held) conflict("Saldo reservado insuficiente para entregar este lote")
    const movement=randomUUID(),next=balance-qty
    await c.client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2",[c.tenantId,line.productId,next])
    await c.client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id) VALUES($1,$2,$3,'issue',$4,$5,$6,$7)",
      [movement,c.tenantId,line.productId,qty,next,`Entrega parcial • lote ${lotId}`,state.orderId])
    await record(c,headers,"stock_movement",movement,"stock.moved",{orderId:state.orderId,lotId,productId:line.productId,quantityMicros:item.quantity,direction:"issue"})
  }
  await c.client.query("UPDATE sales_invoice_lots SET delivered_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[c.tenantId,lotId])
}

export function registerOrderLots(app:FastifyInstance,deps:AccessDependencies,render=renderDanfe) {
  registerReturnPolicy(app,deps)
  registerSalesReturns(app,deps)
  const path="/api/v1/fiscal/order-lots/:id"
  app.get<{Params:{id:string}}>(path,async(request,reply)=>authorizeRequest(request,deps,async c=>{
    access(c)
    const id=z.guid().safeParse(request.params.id),query=z.strictObject({environment,creditOffset:z.coerce.number().int().min(0).max(2147483647).optional()}).safeParse(request.query)
    if (!id.success || !query.success) throw new Problem(422,"invalid_input","Confira o pedido e o ambiente")
    if(query.data.creditOffset!==undefined){
      access(c,"applyCredit")
      if(query.data.environment!=="production")return conflict("Os títulos pertencem à operação de produção")
      const options=await returnCreditTitles(c,id.data,query.data.creditOffset)
      return reply.header("cache-control","no-store").send({tenantId:c.tenantId,orderId:id.data,...options})
    }
    const state=await lotState(c,id.data,query.data.environment)
    return reply.header("cache-control","no-store").header("etag",`"${state.revision}"`).send(state)
  }))
  app.post<{Params:{id:string}}>(path,async(request,reply)=>{
    const id=z.guid().safeParse(request.params.id),parsed=input.safeParse(request.body)
    if (!id.success || !parsed.success) throw new Problem(422,"invalid_input","Confira o pedido, o ambiente e os dados do lote")
    const order=id.data, body=parsed.data, key=commandKey(request.headers["idempotency-key"]),revision=parseRevision(request.headers["if-match"])
    const scope="order.fiscal."+body.action, command={order,revision,...body}
    let digest=""
    if (body.action==="completeOwnReturn" || body.action==="return" || body.action==="decideReturn" && body.approve) {
      // Resolve replays before contacting the private verifier. Check rights again before committing.
      const initial=await authorizeRequest(request,deps,async c=>{
        access(c,body.action)
        const previous=await replay(c,key,scope,command)
        if (previous) return {previous}
        if(body.action==="completeOwnReturn")return {digest:await ownEvidence(c,order,body.planId,render)}
        const received=body.action==="return" ? body.receivedId:(await pendingReturn(c,order,body.requestId)).receivedId
        return {digest:await verifyReturnDocument(c,received,render)}
      },false)
      if (initial.previous) return reply.header("cache-control","no-store").header("etag",`"${initial.previous.revision}"`).send(initial.previous)
      digest=initial.digest!
    }
    const result=await authorizeRequest(request,deps,async c=>{
      access(c,body.action)
      const previous=await replay(c,key,scope,command)
      if (previous) return previous
      const state=await lotState(c,order,body.environment)
      if (state.revision!==revision) throw new Problem(412,"revision_conflict","O pedido mudou. Recarregue os saldos antes de confirmar")
      let affected:string,status:string|undefined
      if(body.action==="prepareOwnReturn" || body.action==="decideOwnReturn" || body.action==="releaseOwnReturn" || body.action==="completeOwnReturn"){
        const effect=body.action==="prepareOwnReturn"?await prepareOwnReturn(c,request.headers,order,body):body.action==="completeOwnReturn"?await completeOwnReturn(c,request.headers,order,body,digest):await changeOwnReturn(c,order,body)
        affected=effect.id;status=effect.status
      } else if (body.action==="prepare") {
        if (state.status!=="confirmed") conflict("Confirme a reserva do pedido antes de preparar o lote")
        if (new Set(body.items.map(i=>i.lineNumber)).size!==body.items.length) conflict("Informe cada linha uma única vez")
        for (const i of body.items) {
          const line=state.lines.find(l=>l.lineNumber===i.lineNumber)
          if (!line || BigInt(i.quantityMicros)>BigInt(line.available)) conflict("A quantidade solicitada excede o saldo para faturamento da linha")
        }
        affected=randomUUID()
        await c.client.query("INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment) VALUES($1,$2,$3,$4)",[c.tenantId,affected,order,body.environment])
        for (const i of body.items) await c.client.query("INSERT INTO sales_invoice_lot_items(tenant_id,lot_id,order_id,line_number,quantity_micros) VALUES($1,$2,$3,$4,$5)",[c.tenantId,affected,order,i.lineNumber,i.quantityMicros])
      } else if (body.action==="withdraw") {
        const lot=state.lots.find(l=>l.id===body.lotId)
        if (!lot || !["reserved","draft"].includes(lot.status) || lot.deliveredAt) conflict("Só um lote sem emissão pode ser liberado")
        await c.client.query("UPDATE sales_invoice_lots SET withdrawn=true WHERE tenant_id=$1 AND id=$2",[c.tenantId,lot.id])
        affected=lot.id
      } else if (body.action==="deliver") {
        await deliver(c,request.headers,state,body.lotId)
        affected=body.lotId
      } else if(body.action==="applyCredit"){
        affected=await applyReturnCredit(c,request.headers,order,body.returnId,body.receivableId,body.amountCents)
      } else {
        if (!["confirmed","completed"].includes(state.status)) conflict("Pedido indisponível para devolução")
        const effect=body.action==="return" ? await submitReturn(c,request.headers,order,body,digest) : await decideReturn(c,request.headers,order,body.requestId,body.approve,body.reason,digest)
        affected=effect.id;status=effect.status
      }
      const next=nextRevision(revision)
      await c.client.query("UPDATE sales_orders SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,order,next])
      await record(c,request.headers,"sales_order",order,scope,{affected,revision:next,previousRevision:revision,...body})
      const result={tenantId:c.tenantId,orderId:order,id:affected,revision:next,...(status?{status}:{})}
      await remember(c,key,scope,command,result)
      return result
    })
    return reply.header("cache-control","no-store").header("etag",`"${result.revision}"`).send(result)
  })
}
