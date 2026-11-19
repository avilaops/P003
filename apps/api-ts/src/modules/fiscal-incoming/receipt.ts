import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"
import { conflict, manage, notFound, prefix, signedId } from "./received.js"
import { ensureInvoiceOperable } from "./purchase.js"
import { invalid } from "./xml.js"

const receiveRights = ["purchasing.receipts.create", "inventory.stock.manage", "finance.payables.originate"]
const receiptInput = z.strictObject({
  reference: z.string().trim().min(3).max(200).refine(value=>!/[\p{Cc}]/u.test(value)),
  occurredOn: z.iso.date(),
  items: z.array(z.strictObject({productId:z.guid(),quantity:z.string()})).min(1).max(100),
})
const optionsPage = z.strictObject({limit:queryInteger(1,100).default(10),offset:queryInteger(0,1000000).default(0)})
type Receipt = z.infer<typeof receiptInput>
type Headers = Parameters<typeof record>[1]

function requireRead(c:AuthorizedContext) {
  if (!c.permissions.includes(manage)) requirePermission(c,"fiscal.monitor.read")
  requirePermission(c,"purchasing.orders.read")
}
async function linked(c:AuthorizedContext, noteId:string) {
  return (await c.client.query(
    `SELECT o.id,o.status,o.revision,o.amount_cents,o.due_date::text,o.supplier_id,o.supplier_name,
       n.access_key,n.environment FROM purchase_orders o
     JOIN fiscal_received_purchase_links l ON l.tenant_id=o.tenant_id AND l.purchase_order_id=o.id
     JOIN fiscal_received_nfes n ON n.tenant_id=l.tenant_id AND n.id=l.received_nfe_id
     WHERE l.tenant_id=$1 AND l.received_nfe_id=$2`,[c.tenantId,noteId])).rows[0]??notFound()
}
async function readProgress(c:AuthorizedContext,noteId:string) {
  const order=await linked(c,noteId)
  const items=(await c.client.query(
    `SELECT l.product_id AS "productId",l.name,l.unit,l.received_micros AS received,
       least(l.quantity_micros,c.quantity_micros) AS allowed
     FROM purchase_order_lines l JOIN fiscal_received_item_costs c
       ON c.tenant_id=l.tenant_id AND c.purchase_order_id=l.order_id AND c.product_id=l.product_id
     WHERE l.tenant_id=$1 AND l.order_id=$2 ORDER BY l.line_number`,[c.tenantId,order.id])).rows
  const receipts=(await c.client.query(
    `SELECT r.id,r.reference,r.occurred_on::text AS "occurredOn",r.amount_cents,p.id AS "payableId"
     FROM purchase_receipts r LEFT JOIN payables p ON p.tenant_id=r.tenant_id AND p.receipt_id=r.id
     WHERE r.tenant_id=$1 AND r.order_id=$2 ORDER BY r.occurred_on DESC,r.id DESC`,[c.tenantId,order.id])).rows
  return {tenantId:c.tenantId,purchaseOrderId:order.id,revision:revisionValue(order.revision),status:order.status,
    canConfirm:c.permissions.includes("purchasing.orders.manage"),canReceive:receiveRights.every(p=>c.permissions.includes(p)),
    items:items.map(i=>({productId:i.productId,name:i.name,unit:i.unit,received:decimal(BigInt(String(i.received)),6),remaining:decimal(BigInt(String(i.allowed))-BigInt(String(i.received)),6)})),
    receipts:receipts.map(r=>({id:r.id,reference:r.reference,occurredOn:r.occurredOn,amount:decimal(BigInt(String(r.amount_cents)),2),payableId:r.payableId}))}
}
async function confirm(c:AuthorizedContext,order:Awaited<ReturnType<typeof linked>>) {
  if(order.status!=="draft") conflict("Somente compras em rascunho podem ser confirmadas")
  const controls=(await c.client.query(`SELECT p.status='active' AND p.is_supplier AS active,
    coalesce($3::bigint>=s.minimum_order_amount_cents,true) AS minimum,
    coalesce($4::date<=(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+s.maximum_payment_term_days,true) AS term,
    (s.require_supplier_contact IS DISTINCT FROM true OR nullif(trim(p.email),'') IS NOT NULL OR nullif(trim(p.phone),'') IS NOT NULL) AS contact
    FROM parties p LEFT JOIN purchase_settings s ON s.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.id=$2`,
    [c.tenantId,order.supplier_id,order.amount_cents,order.due_date])).rows[0]
  if(!controls?.active) conflict("Fornecedor inativo ou indisponível")
  if(!controls.minimum) conflict("Valor inferior ao mínimo configurado para compras")
  if(!controls.term) conflict("Vencimento excede o prazo máximo configurado para compras")
  if(!controls.contact) conflict("O fornecedor precisa de um contato para confirmar a compra")
  const unavailable=await c.client.query(`SELECT 1 FROM purchase_order_lines l JOIN products p
    ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE l.tenant_id=$1 AND l.order_id=$2
    AND (p.status<>'active' OR p.unit<>l.unit) LIMIT 1`,[c.tenantId,order.id])
  if(unavailable.rows.length) conflict("Há produtos inativos ou com unidade divergente na compra")
}
const amount=(q:bigint,unit:bigint)=>(q*unit+500000n)/1000000n
async function receive(c:AuthorizedContext,headers:Headers,order:Awaited<ReturnType<typeof linked>>,input:Receipt) {
  if(!["confirmed","partially_received"].includes(String(order.status))) conflict("Confirme a compra e confira o saldo pendente antes de receber")
  validateDate(input.occurredOn)
  if(new Set(input.items.map(i=>i.productId)).size!==input.items.length) invalid("Informe uma quantidade por produto")
  const duplicate=await c.client.query("SELECT 1 FROM purchase_receipts WHERE tenant_id=$1 AND order_id=$2 AND reference=$3",[c.tenantId,order.id,input.reference])
  if(duplicate.rows.length) conflict("Referência já recebida nesta compra")
  const prepared=[]
  let total=0n
  for (const item of input.items) {
    const quantity=fixed(item.quantity,6)
    if(quantity<=0n) invalid("Quantidade recebida deve ser positiva")
    const line=(await c.client.query(`SELECT l.unit,l.cost_cents,l.received_micros,
      least(l.quantity_micros,f.quantity_micros) AS allowed FROM purchase_order_lines l
      JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id AND p.status='active' AND p.unit=l.unit
      JOIN fiscal_received_item_costs f ON f.tenant_id=l.tenant_id AND f.purchase_order_id=l.order_id AND f.product_id=l.product_id
      WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.product_id=$3 FOR UPDATE OF l`,[c.tenantId,order.id,item.productId])).rows[0]
    if(!line) conflict("Produto indisponível ou ausente dos itens vinculados")
    const received=BigInt(String(line.received_micros)),cumulative=received+quantity,cost=BigInt(String(line.cost_cents))
    if(cumulative>BigInt(String(line.allowed))) conflict("Quantidade excede o saldo da compra ou da nota")
    const delta=amount(cumulative,cost)-amount(received,cost)
    total+=delta
    prepared.push({product:item.productId,quantity,cumulative,delta,unit:line.unit})
  }
  if(total>99999999999999n) invalid("Valor total fora do limite")
  const receipt=randomUUID()
  await c.client.query("INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,$4,$5,$6)",[receipt,c.tenantId,order.id,input.reference,input.occurredOn,total])
  for(const line of prepared) {
    await c.client.query("INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,product_id,unit,quantity_micros,amount_cents) VALUES($1,$2,$3,$4,$5,$6)",[c.tenantId,receipt,line.product,line.unit,line.quantity,line.delta])
    const balance=(await c.client.query(`INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,product_id) DO UPDATE SET quantity_micros=stock_balances.quantity_micros+EXCLUDED.quantity_micros
      WHERE stock_balances.quantity_micros<=999999999999999999-EXCLUDED.quantity_micros RETURNING quantity_micros`,[c.tenantId,line.product,line.quantity])).rows[0]
    if(!balance) conflict("Saldo de estoque excede o limite")
    const movement=randomUUID()
    await c.client.query(`INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_purchase_receipt_id)
      VALUES($1,$2,$3,'receipt',$4,$5,$6,$7)`,[movement,c.tenantId,line.product,line.quantity,balance.quantity_micros,"Recebimento de compra "+receipt,receipt])
    await record(c,headers,"stock_movement",movement,"stock.moved",{sourcePurchaseReceiptId:receipt,productId:line.product,direction:"receipt",quantity:decimal(line.quantity,6),balanceAfter:decimal(BigInt(String(balance.quantity_micros)),6)})
    await c.client.query("UPDATE purchase_order_lines SET received_micros=$4 WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3",[c.tenantId,order.id,line.product,line.cumulative])
  }
  const payable=total>0n?randomUUID():null
  if(payable) {
    await c.client.query("INSERT INTO payables(id,tenant_id,receipt_id,supplier_name,due_date,amount_cents) VALUES($1,$2,$3,$4,$5,$6)",[payable,c.tenantId,receipt,order.supplier_name,order.due_date,total])
    await record(c,headers,"payable",payable,"payable.created",{receiptId:receipt,amount:decimal(total,2),revision:1})
  }
  const pending=await c.client.query("SELECT 1 FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2 AND quantity_micros>received_micros LIMIT 1",[c.tenantId,order.id])
  await record(c,headers,"purchase_receipt",receipt,"purchase.received",{orderId:order.id,payableId:payable,amount:decimal(total,2),orderRevision:nextRevision(revisionValue(order.revision))})
  return {status:pending.rows.length?"partially_received":"received",receiptId:receipt}
}
export function registerFiscalPurchaseReceipt(app:FastifyInstance,deps:AppDependencies) {
  const url=prefix+"/received-nfes/:id/purchase/"
  app.get<{Params:{id:string}}>(url+"options",async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requireRead(c)
    const note=signedId(req.params.id),q=optionsPage.safeParse(req.query)
    if(!q.success) invalid("Paginação inválida")
    const from=` FROM purchase_orders o JOIN fiscal_received_nfes n ON n.tenant_id=o.tenant_id AND n.id=$2 AND n.own_return_document_id IS NULL AND n.issuer_document=o.supplier_tax_id
      WHERE o.tenant_id=$1 AND o.status='confirmed' AND NOT EXISTS(SELECT 1 FROM purchase_receipts r WHERE r.tenant_id=o.tenant_id AND r.order_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM fiscal_received_purchase_links l WHERE l.tenant_id=o.tenant_id AND l.purchase_order_id=o.id)`
    const rows=(await c.client.query('SELECT o.id,o.revision,o.status,o.supplier_name AS "supplierName",o.amount_cents'+from+" ORDER BY o.created_at DESC,o.id LIMIT $3 OFFSET $4",[c.tenantId,note,q.data.limit,q.data.offset])).rows
    const total=(await c.client.query("SELECT count(*)::int AS count"+from,[c.tenantId,note])).rows[0]!.count
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,data:rows.map(r=>({id:r.id,revision:revisionValue(r.revision),status:r.status,supplierName:r.supplierName,amount:decimal(BigInt(String(r.amount_cents)),2)})),total})
  }))
  app.get<{Params:{id:string}}>(url+"progress",async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requireRead(c)
    const body=await readProgress(c,signedId(req.params.id))
    return reply.header("etag",'"'+body.revision+'"').header("cache-control","no-store").send(body)
  }))
  for(const action of ["confirm","receive"] as const) app.post<{Params:{id:string}}>(url+action,async(req,reply)=>{
    const confirming=action==="confirm"
    const result=await authorizeRequest(req,deps,async c=>{
      requireRead(c)
      for(const p of confirming?["purchasing.orders.manage"]:receiveRights)requirePermission(c,p)
      const id=signedId(req.params.id),rev=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"])
      const data=confirming?z.strictObject({}).safeParse(req.body):receiptInput.safeParse(req.body)
      if(!data.success)invalid("Confira a referência, data e quantidades")
      const scope="fiscal.received.purchase."+action,command={id,revision:rev,input:data.data}
      let body=await replay(c,key,scope,command)
      if(!body){
        const order=await linked(c,id)
        if(revisionValue(order.revision)!==rev) throw new Problem(412,"revision_conflict","A compra mudou. Atualize o recebimento")
        await ensureInvoiceOperable(c,{key:String(order.access_key),environment:Number(order.environment)})
        let status="confirmed",receiptId:string|undefined
        if(confirming)await confirm(c,order)
        else {
          const result=await receive(c,req.headers,order,data.data as Receipt)
          status=result.status
          receiptId=result.receiptId
        }
        await c.client.query("UPDATE purchase_orders SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,order.id,status])
        await record(c,req.headers,"purchase_order",String(order.id),confirming?"purchase.confirmed":"purchase.receipt_applied",{status,previousRevision:rev,revision:nextRevision(rev),receiptId})
        body=await readProgress(c,id)
        await remember(c,key,scope,command,body)
      }
      return body
    })
    return reply.code(confirming?200:201).header("etag",'"'+result.revision+'"').header("cache-control","no-store").send(result)
  })
}
