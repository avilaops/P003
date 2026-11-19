import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,record,replay,remember } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision,revisionValue } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { conflict,manage,notFound,prefix,recipient,signedId } from "./received.js"
import { invalid,purchaseItems } from "./xml.js"
import { storedEvidence } from "./evidence.js"

const mapping=z.array(z.strictObject({itemNumber:z.number().int().min(1).max(990),productId:z.guid()})).min(1).max(100)
const create=z.strictObject({supplierId:z.guid(),dueDate:z.iso.date(),items:mapping})
const match=z.strictObject({purchaseOrderId:z.guid(),purchaseRevision:z.number().int().positive().safe(),items:mapping})
type Mapping=z.infer<typeof mapping>
type Match=z.infer<typeof match>
async function source(c:AuthorizedContext,id:string) {
  const n=(await c.client.query("SELECT n.xml,n.access_key,n.issuer_document,n.environment,n.own_return_document_id,l.purchase_order_id FROM fiscal_received_nfes n LEFT JOIN fiscal_received_purchase_links l ON l.tenant_id=n.tenant_id AND l.received_nfe_id=n.id WHERE n.tenant_id=$1 AND n.id=$2",[c.tenantId,id])).rows[0]??notFound()
  if(n.own_return_document_id)throw new Problem(409,"domain_conflict","Entrada de devolução própria não pode ser vinculada a uma compra")
  const items=purchaseItems(String(n.xml),await recipient(c))
  return {items,key:String(n.access_key),issuer:String(n.issuer_document),environment:Number(n.environment),link:n.purchase_order_id as string|null}
}
type Source=Awaited<ReturnType<typeof source>>
function pairs(s:Source,m:Mapping) {
  const index=new Map(m.map(i=>[i.itemNumber,i.productId]))
  if(index.size!==m.length || new Set(index.values()).size!==m.length || m.length!==s.items.length || s.items.some(i=>!index.has(i.number))) invalid("Mapeie todos os itens para produtos distintos")
  return s.items.map(item=>({...item,productId:index.get(item.number)!}))
}
export async function ensureInvoiceOperable(c:AuthorizedContext,s:Pick<Source,"environment"|"key">) {
  if(s.environment!==1)return
  const blocked=await c.client.query("SELECT 1 FROM fiscal_monitor_documents WHERE tenant_id=$1 AND access_key=$2 AND situation IN ('2','3') LIMIT 1",[c.tenantId,s.key])
  if(blocked.rows.length || (await storedEvidence(c,s.key,true)).some(e=>e.eventType==="110111")) conflict("NF-e com cancelamento ou denegação conhecidos. Confira a origem fiscal")
}
async function preview(c:AuthorizedContext,s:Source,input:Match,id:string) {
  const order=(await c.client.query("SELECT supplier_id,supplier_tax_id,status,revision FROM purchase_orders WHERE tenant_id=$1 AND id=$2",[c.tenantId,input.purchaseOrderId])).rows[0]??notFound()
  if(revisionValue(order.revision)!==input.purchaseRevision) throw new Problem(412,"revision_conflict","A compra mudou. Atualize a prévia")
  const differences:{code:string;itemNumber:number|null;blocking:boolean;message:string}[]=[]
  const add=(code:string,message:string,itemNumber:number|null=null,blocking=true)=>differences.push({code,message,itemNumber,blocking})
  const linked=(await c.client.query("SELECT 1 FROM fiscal_received_purchase_links WHERE tenant_id=$1 AND (purchase_order_id=$2 OR received_nfe_id=$3)",[c.tenantId,input.purchaseOrderId,id])).rows.length
  if(linked)add("already_linked","A nota ou a compra já tem vínculo fiscal")
  const supplier=(await c.client.query("SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND tax_id=$3 AND is_supplier AND status='active'",[c.tenantId,order.supplier_id,s.issuer])).rows.length
  if(!supplier || order.supplier_tax_id!==s.issuer) add("supplier_mismatch","O fornecedor ativo deve corresponder ao emitente")
  const receipts=(await c.client.query("SELECT 1 FROM purchase_receipts WHERE tenant_id=$1 AND order_id=$2 LIMIT 1",[c.tenantId,input.purchaseOrderId])).rows.length
  if(order.status!=="confirmed" || receipts) add("purchase_not_eligible","Selecione uma compra confirmada sem recebimento anterior")
  const lines=pairs(s,input.items),items=[]
  for(const i of lines){
    const p=(await c.client.query(`SELECT p.unit,p.ncm,p.status,l.unit AS ordered_unit,l.quantity_micros-l.received_micros AS remaining,l.cost_cents FROM products p LEFT JOIN purchase_order_lines l ON l.tenant_id=p.tenant_id AND l.product_id=p.id AND l.order_id=$3 WHERE p.tenant_id=$1 AND p.id=$2`,[c.tenantId,i.productId,input.purchaseOrderId])).rows[0]
    const remaining=BigInt(String(p?.remaining??0)), cost=p?.cost_cents==null?null:BigInt(String(p.cost_cents))
    if(!p || p.status!=="active" || p.unit!==i.unit) add("catalog_mismatch","Produto indisponível ou unidade divergente",i.number)
    if(!p?.ordered_unit) add("product_not_in_purchase","Produto ausente da compra",i.number)
    else {
      if(p.ordered_unit!==i.unit) add("unit_mismatch","Unidade comercial divergente",i.number)
      if(i.quantityMicros>remaining) add("quantity_exceeded","Quantidade supera o saldo da compra",i.number)
      if(cost!==i.unitCostCents) add("unit_cost_mismatch","Custo posto diverge do aprovado",i.number)
    }
    if(p && p.ncm!==i.ncm) add(p.ncm?"ncm_mismatch":"ncm_missing","Confira o NCM cadastrado para este produto",i.number,false)
    items.push({itemNumber:i.number,productId:i.productId,name:i.name,unit:i.unit,ncm:i.ncm,invoiceQuantityMicros:i.quantityMicros,remainingQuantityMicros:remaining,invoiceUnitCostCents:i.unitCostCents,purchaseUnitCostCents:cost,landedCents:i.landedCents,components:i.components})
  }
  return {supplier:String(order.supplier_id),lines,body:{receivedNfeId:BigInt(id),purchaseOrderId:input.purchaseOrderId,purchaseRevision:input.purchaseRevision,canConfirm:!differences.some(d=>d.blocking),invoiceTotalCents:lines.reduce((sum,i)=>sum+i.landedCents,0n),differences,items}}
}
export function registerInvoicePurchases(app:FastifyInstance,deps:AppDependencies) {
  const url=prefix+"/received-nfes/:id/purchase"
  app.get<{Params:{id:string}}>(url,async(req,reply)=>authorizeRequest(req,deps,async c=>{
    if(!c.permissions.includes(manage)) requirePermission(c,"fiscal.monitor.read")
    const id=signedId(req.params.id),s=await source(c,id),revision=s.link?2:1
    const costs=(await c.client.query(`SELECT item_number AS "itemNumber",product_id AS "productId",unit,quantity_micros AS "quantityMicros",unit_cost_cents AS "unitCostCents",merchandise_cents AS "merchandiseCents",landed_cents AS "landedCents",components FROM fiscal_received_item_costs WHERE tenant_id=$1 AND received_nfe_id=$2 ORDER BY item_number`,[c.tenantId,id])).rows
    return reply.header("etag",'"'+revision+'"').header("cache-control","no-store").send({receivedNfeId:BigInt(id),revision,purchaseOrderId:s.link,costs,items:s.items,canConvert:c.permissions.includes(manage)&&c.permissions.includes("purchasing.orders.manage")&&c.permissions.includes("purchasing.orders.read")})
  }))
  for(const action of ["create","preview","match"] as const) app.post<{Params:{id:string}}>(url+(action==="create"?"":"/"+action),async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,manage);requirePermission(c,"purchasing.orders.read");requirePermission(c,"purchasing.orders.manage")
      const id=signedId(req.params.id),creating=action==="create",parsed=(creating?create:match).safeParse(req.body)
      if(!parsed.success) invalid("Informe todos os itens, fornecedor, vencimento ou revisão da compra")
      const input=parsed.data, scope=creating?"fiscal.received.convert":"fiscal.received.purchase_match"
      const revision=action==="preview"?null:parseRevision(req.headers["if-match"]), key=action==="preview"?null:commandKey(req.headers["idempotency-key"])
      const command={receivedNfeId:BigInt(id),mapping:input}
      if(key){const previous=await replay(c,key,scope,command);if(previous)return previous}
      const s=await source(c,id);await ensureInvoiceOperable(c,s)
      if(revision!==null && revision!==(s.link?2:1)) throw new Problem(412,"revision_conflict","A nota mudou. Atualize o vínculo")
      const purchase="purchaseOrderId" in input?input.purchaseOrderId:randomUUID()
      let supplier:string, orderSnapshot:unknown,lines:ReturnType<typeof pairs>
      if("supplierId" in input){
        if(s.link) conflict("NF-e já vinculada a compra")
        supplier=input.supplierId
        const party=(await c.client.query("SELECT legal_name FROM parties WHERE tenant_id=$1 AND id=$2 AND is_supplier AND status='active' AND tax_id=$3",[c.tenantId,supplier,s.issuer])).rows[0]??conflict("Fornecedor ativo deve corresponder ao emitente")
        lines=pairs(s,input.items)
        const amount=lines.reduce((n,i)=>n+i.landedCents,0n)
        if(amount<1n || amount>99999999999999n) invalid("O valor da compra deve ser positivo e dentro do limite")
        await c.client.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')",[purchase,c.tenantId,supplier,party.legal_name,s.issuer,input.dueDate,amount])
        for(const i of lines){
          const product=(await c.client.query("SELECT sku,name,unit FROM products WHERE tenant_id=$1 AND id=$2 AND status='active'",[c.tenantId,i.productId])).rows[0]
          if(!product || product.unit!==i.unit) conflict("Produto ativo e unidade do catálogo devem corresponder ao item fiscal")
          await c.client.query("INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[c.tenantId,purchase,i.productId,i.number,product.sku,product.name,i.unit,i.quantityMicros,i.unitCostCents,i.landedCents])
        }
        orderSnapshot={tenantId:c.tenantId,data:{id:purchase,revision:1,supplierId:supplier,supplierName:party.legal_name,supplierTaxId:s.issuer,status:"draft",dueDate:input.dueDate,amount:decimal(amount,2)},items:lines.map(i=>({productId:i.productId,quantity:decimal(i.quantityMicros,6),receivedQuantity:"0.000000",unitCost:decimal(i.unitCostCents,2),amount:decimal(i.landedCents,2),name:i.name,unit:i.unit})),receipts:[],canEdit:true}
      } else {
        const prepared=await preview(c,s,input,id)
        if(action==="preview")return prepared.body
        if(!prepared.body.canConfirm) conflict("Resolva as divergências bloqueantes antes de vincular a compra")
        supplier=prepared.supplier;lines=prepared.lines
        await c.client.query("UPDATE purchase_orders SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,purchase])
      }
      await c.client.query("INSERT INTO fiscal_received_purchase_links(tenant_id,received_nfe_id,purchase_order_id,supplier_id) VALUES($1,$2,$3,$4)",[c.tenantId,id,purchase,supplier])
      for(const i of lines) await c.client.query("INSERT INTO fiscal_received_item_costs(tenant_id,received_nfe_id,item_number,product_id,purchase_order_id,unit,quantity_micros,unit_cost_cents,merchandise_cents,landed_cents,components) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[c.tenantId,id,i.number,i.productId,purchase,i.unit,i.quantityMicros,i.unitCostCents,i.merchandiseCents,i.landedCents,i.components])
      await record(c,req.headers,"purchase_order",purchase,creating?"purchase.created":"fiscal.received.purchase_linked",{receivedNfeId:BigInt(id),origin:"fiscal_received_nfe"})
      const body={receivedNfeId:BigInt(id),revision:2,purchaseOrderId:purchase,...(orderSnapshot?{purchase:orderSnapshot}:{})}
      await remember(c,key!,scope,command,body)
      return body
    },action!=="preview")
    return reply.code(action==="create"?201:200).header("etag",action==="preview"?'"1"':'"2"').header("cache-control","no-store").send(result)
  })
}
