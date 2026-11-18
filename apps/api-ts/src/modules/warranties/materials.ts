import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AccessDependencies, AuthorizedContext } from "../../platform/access.js"
import { nextRevision } from "../../platform/revision.js"
import { heldQuantity } from "../orders/fulfillment.js"
import { registerWarrantySettlements } from "./settlement.js"
import { activeCase, base, bump } from "./service.js"
import { command, conflict, current, event, idParam, invalid, limitedText, manage, metadata, money } from "./shared.js"

const quantity=z.string().regex(/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/).refine(v=>/[1-9]/.test(v))
function units(raw:string) {
  const [whole,fraction=""]=raw.split(".")
  return BigInt(whole!+fraction.padEnd(6,"0"))
}
async function movement(ctx:AuthorizedContext, product: string, quantity:bigint, reason:string, reverses:string|null=null) {
  const row=(await ctx.client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE",[ctx.tenantId,product])).rows[0]
  if (!row) return conflict("Saldo de estoque não encontrado")
  const balance=BigInt(String(row.quantity_micros))
  if (!reverses && balance - await heldQuantity(ctx,product) < quantity) conflict("Quantidade superior ao estoque disponível")
  const next=reverses ? balance+quantity : balance-quantity
  const id=randomUUID()
  await ctx.client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2",[ctx.tenantId,product,next])
  await ctx.client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,ctx.tenantId,product,reverses?"receipt":"issue",quantity,next,reason,reverses])
  return id
}
export function registerWarrantyMaterials(app:FastifyInstance,deps:AccessDependencies) {
  command(app,deps,"/api/v1/warranty-service-orders/:id/parts",z.strictObject({productId:idParam,quantity,amountCents:money}),"warranty.service_order.part_added","warranty_service_order_part",manage,async(ctx,input,orderId,expected)=>{
    const order=await current(ctx,"warranty_service_orders",orderId,expected)
    if (["completed","cancelled"].includes(String(order.status))) conflict("Ordem de serviço encerrada")
    const caseId=String(order.case_id)
    const active=(await ctx.client.query("SELECT status,protocol FROM warranty_cases WHERE id=$2 AND tenant_id=$1",[ctx.tenantId,caseId])).rows[0]!
    if (active.status==="closed" || active.status==="cancelled") conflict("A garantia já está encerrada")
    const product=(await ctx.client.query("SELECT name,sku FROM products WHERE tenant_id=$1 AND id=$2 AND status='active'",[ctx.tenantId,input.productId])).rows[0]
    if (!product) return invalid("Selecione um produto ativo da empresa")
    const amount=units(input.quantity), id=randomUUID()
    const stockMovementId=await movement(ctx,input.productId,amount,"Peça aplicada na garantia "+active.protocol)
    await ctx.client.query("INSERT INTO warranty_service_order_parts(id,tenant_id,service_order_id,product_id,product_name,sku,quantity_micros,amount_cents,stock_movement_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,ctx.tenantId,orderId,input.productId,product.name,product.sku,amount,input.amountCents,stockMovementId])
    await ctx.client.query("UPDATE warranty_service_orders SET status='in_repair',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,orderId])
    const data={id,caseId,serviceOrderId:orderId,stockMovementId,...input,sku:product.sku,productName:product.name,revision:nextRevision(expected)}
    await event(ctx,caseId,"treated","in_repair",data)
    return {data,aggregateId:id}
  })
  command(app,deps,base+"/quarantine",z.strictObject({productId:idParam,quantity,reason:limitedText(3,500)}),"warranty.quarantine.created","warranty_quarantine",manage,async(ctx,input,caseId,expected)=>{
    const row=await activeCase(ctx,caseId,expected)
    if (row.product_id && row.product_id!==input.productId) invalid("O produto deve corresponder à garantia")
    const amount=units(input.quantity), id=randomUUID()
    const stockMovementId=await movement(ctx,input.productId,amount,"Quarentena da garantia "+row.protocol)
    await ctx.client.query("INSERT INTO warranty_quarantines(id,tenant_id,case_id,product_id,quantity_micros,stock_movement_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,ctx.tenantId,caseId,input.productId,amount,stockMovementId,input.reason])
    await bump(ctx,caseId)
    const data={id,caseId,...input,stockMovementId,status:"quarantined",revision:1,caseRevision:nextRevision(expected)}
    await event(ctx,caseId,"note","quarantined",data)
    return {data,aggregateId:id}
  })
  command(app,deps,"/api/v1/warranty-quarantines/:id/transition",z.strictObject({status:z.enum(["released","disposed"]),details:metadata.default({})}),"warranty.quarantine.transitioned","warranty_quarantine",manage,async(ctx,input,id,expected)=>{
    const row=await current(ctx,"warranty_quarantines",id,expected)
    if (row.status!=="quarantined") conflict("Quarentena já encerrada")
    const releaseMovementId=input.status==="released" ? await movement(ctx,String(row.product_id),BigInt(String(row.quantity_micros)),"Liberação de quarentena "+id,String(row.stock_movement_id)) : null
    await ctx.client.query("UPDATE warranty_quarantines SET status=$3,release_movement_id=$4,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,id,input.status,releaseMovementId])
    const data={id,caseId:String(row.case_id),status:input.status,releaseMovementId,revision:nextRevision(expected)}
    await event(ctx,data.caseId,"note",input.status,{...input.details,...data})
    return {data,aggregateId:id}
  })
  command(app,deps,base+"/rma",z.strictObject({supplierId:idParam.nullish(),carrier:limitedText(1,160).nullish(),trackingCode:limitedText(1,120).nullish(),notes:limitedText(0,4000).default("")}),"warranty.rma.created","warranty_rma",manage,async(ctx,input,caseId,expected)=>{
    await activeCase(ctx,caseId,expected)
    if (input.supplierId && !(await ctx.client.query("SELECT id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_supplier AND status='active'",[ctx.tenantId,input.supplierId])).rows.length) invalid("Selecione um fornecedor ativo")
    const id=randomUUID(), reference="RMA-"+id.replaceAll("-","")
    await ctx.client.query("INSERT INTO warranty_rmas(id,tenant_id,case_id,supplier_id,carrier,tracking_code,notes,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,ctx.tenantId,caseId,input.supplierId,input.carrier,input.trackingCode,input.notes,reference])
    await bump(ctx,caseId)
    const data={id,caseId,reference,status:"requested",revision:1,caseRevision:nextRevision(expected)}
    await event(ctx,caseId,"note",data.status,data)
    return {data,aggregateId:id}
  })
  const steps: Record<string,string[]>={requested:["authorized","in_transit","cancelled"],authorized:["in_transit","cancelled"],in_transit:["received"],received:["closed"]}
  command(app,deps,"/api/v1/warranty-rmas/:id/transition",z.strictObject({status:z.enum(["authorized","in_transit","received","closed","cancelled"]),details:metadata.default({})}),"warranty.rma.transitioned","warranty_rma",manage,async(ctx,input,id,expected)=>{
    const row=await current(ctx,"warranty_rmas",id,expected)
    if (!steps[String(row.status)]?.includes(input.status)) conflict("Transição de RMA indisponível")
    await ctx.client.query("UPDATE warranty_rmas SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,id,input.status])
    const data={id,caseId:String(row.case_id),status:input.status,revision:nextRevision(expected)}
    await event(ctx,data.caseId,"note",input.status,{...input.details,...data})
    return {data,aggregateId:id}
  })
  registerWarrantySettlements(app,deps)
}
