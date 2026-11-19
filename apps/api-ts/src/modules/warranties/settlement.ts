import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { heldQuantity } from "../orders/fulfillment.js"
import { queryInteger } from "../registrations/query.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"
import { base, bump } from "./service.js"
import { approve, conflict, current, event, idParam, invalid, limitedText, manage, parse, read } from "./shared.js"

const stockRight="inventory.stock.manage", bankRight="finance.account_entries.manage", creditRight="finance.receivables.manage"
const common={reference:limitedText(3,160),occurredOn:z.iso.date()}
const qty=z.string().regex(/^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/).refine(s=>fixed(s,6)>0n)
const cents=z.number().int().min(1).max(99999999999999)
const command=z.discriminatedUnion("kind",[
  z.strictObject({...common,kind:z.literal("review"),approvalId:idParam}),
  z.strictObject({...common,kind:z.literal("credit"),approvalId:idParam}),
  z.strictObject({...common,kind:z.literal("refund"),approvalId:idParam,accountId:idParam}),
  z.strictObject({...common,kind:z.literal("exchange"),approvalId:idParam,quantity:qty}),
  z.strictObject({...common,kind:z.literal("intake"),quantity:qty}),
  z.strictObject({...common,kind:z.literal("repair_return"),quantity:qty,serviceOrderId:idParam}),
  z.strictObject({...common,kind:z.literal("scrap"),quantity:qty}),
  z.strictObject({...common,kind:z.literal("supplier_cash"),rmaId:idParam,supplierId:idParam,accountId:idParam,amountCents:cents}),
  z.strictObject({...common,kind:z.literal("supplier_stock"),rmaId:idParam,supplierId:idParam,quantity:qty}),
  z.strictObject({...common,kind:z.literal("apply_credit"),sourceCreditId:idParam,receivableId:idParam,amountCents:cents}),
])
type Input=z.infer<typeof command>
type Headers=Parameters<typeof record>[1]
const n=(v:unknown)=>BigInt(String(v??0))
const permission=(kind:Input["kind"])=>kind==="review"?approve:kind==="refund"||kind==="supplier_cash"?bankRight:kind==="credit"||kind==="apply_credit"?creditRight:stockRight
const missing=():never=>{throw new Problem(404,"not_found","Garantia não encontrada")}
const custodySum="coalesce(sum(CASE WHEN kind='intake' THEN quantity_micros WHEN kind IN ('repair_return','scrap','supplier_stock') THEN -quantity_micros ELSE 0 END),0)"
const accountFrom=" FROM financial_accounts a WHERE a.tenant_id=$1 AND a.status='active' AND NOT EXISTS(SELECT FROM pos_sessions s WHERE s.tenant_id=a.tenant_id AND s.cash_account_id=a.id AND s.status='open')"
const openAmount="r.amount_cents-coalesce((SELECT sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END) FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id),0)"

async function decisionActors(c:AuthorizedContext,caseId:string,approvalId:string) {
  const row=(await c.client.query(`SELECT
    (SELECT identity_id FROM audit_log WHERE tenant_id=$1 AND entity_id=$2 AND action IN ('warranty.case.opened','warranty.case.created') ORDER BY occurred_at,id LIMIT 1) AS requester,
    (SELECT identity_id FROM audit_log WHERE tenant_id=$1 AND
      ((entity_id=$2 AND action='warranty.case.approved' AND details->>'id'=$3) OR (entity_id=$3 AND action='warranty.case.approval.created')) ORDER BY occurred_at,id LIMIT 1) AS decider,
    (SELECT reviewer_id FROM warranty_settlement_reviews WHERE tenant_id=$1 AND approval_id=$3::text::uuid) AS reviewer,
    (SELECT id FROM identities WHERE auth_subject=$4) AS actor`,[c.tenantId,caseId,approvalId,c.authSubject])).rows[0]!
  if(!row.requester||!row.decider||!row.actor) conflict("Histórico de autoria insuficiente para executar a decisão")
  return row
}
async function origin(c:AuthorizedContext,caseId:string) {
  const row=(await c.client.query(`SELECT w.product_id,coalesce(w.customer_id,o.customer_id) AS customer_id,w.order_id,l.line_number,w.serial_number,w.lot,w.document_id,w.equipment_id,w.protocol,w.status,w.revision,
    o.status AS order_status,o.customer_id AS order_customer,l.product_id AS sold_product,l.quantity_micros,l.amount_cents,
    returned.quantity+pending.quantity AS returned_quantity,returned.amount+pending.amount AS returned_amount,
    CASE WHEN o.status='completed' THEN l.quantity_micros ELSE order_line_delivered(w.tenant_id,w.order_id,l.line_number) END AS delivered
    FROM warranty_cases w LEFT JOIN sales_orders o ON o.tenant_id=w.tenant_id AND o.id=w.order_id
    LEFT JOIN sales_order_lines l ON l.tenant_id=w.tenant_id AND l.order_id=w.order_id AND l.line_number=coalesce(w.line_number,(SELECT CASE WHEN count(*)=1 THEN min(x.line_number) END FROM sales_order_lines x WHERE x.tenant_id=w.tenant_id AND x.order_id=w.order_id AND x.product_id=w.product_id))
    CROSS JOIN LATERAL sales_pending_return_balance(l.tenant_id,l.order_id,l.line_number) pending
    LEFT JOIN LATERAL (SELECT coalesce(sum(i.quantity_micros),0) AS quantity,coalesce(sum(i.value_cents),0) AS amount
      FROM sales_partial_return_items i JOIN sales_invoice_lots lot ON lot.tenant_id=i.tenant_id AND lot.id=i.lot_id
      WHERE i.tenant_id=l.tenant_id AND lot.order_id=l.order_id AND i.line_number=l.line_number) returned ON true
    WHERE w.tenant_id=$1 AND w.id=$2`,[c.tenantId,caseId])).rows[0]??missing()
  const valid=!!row.sold_product && row.sold_product===row.product_id && row.order_customer===row.customer_id &&
    ["confirmed","completed"].includes(String(row.order_status)) && n(row.delivered)>0n
  return {row,valid}
}
async function summary(c:AuthorizedContext,caseId:string,offset:number) {
  const {row,valid}=await origin(c,caseId)
  const canBank=c.permissions.includes(manage)&&c.permissions.includes(bankRight)
  const canCredit=c.permissions.includes(manage)&&c.permissions.includes(creditRight)
  const canStock=c.permissions.includes(manage)&&c.permissions.includes(stockRight)
  const movements=(await c.client.query(`SELECT s.id,s.kind,s.reference,s.occurred_on::text AS "occurredOn",s.quantity_micros AS "quantityMicros",s.amount_cents AS "amountCents",
      s.approval_id AS "approvalId",s.rma_id AS "rmaId",s.service_order_id AS "serviceOrderId",s.supplier_id AS "supplierId",s.source_credit_id AS "sourceCreditId",
      s.stock_movement_id AS "stockMovementId",s.account_entry_id AS "accountEntryId",s.receivable_id AS "receivableId",s.origin,
      CASE WHEN s.kind='credit' THEN s.amount_cents-coalesce((SELECT sum(a.amount_cents) FROM warranty_settlements a WHERE a.tenant_id=s.tenant_id AND a.source_credit_id=s.id),0) END AS "creditRemainingCents"
    FROM warranty_settlements s WHERE s.tenant_id=$1 AND s.case_id=$2 ORDER BY s.created_at DESC,s.id`,[c.tenantId,caseId])).rows
  const accounts=canBank?(await c.client.query("SELECT a.id,a.name"+accountFrom+" ORDER BY a.name,a.id",[c.tenantId])).rows:[]
  const eligibleBills=` FROM receivables r JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id
    WHERE r.tenant_id=$1 AND o.customer_id=$2 AND r.status='open' AND ${openAmount}>0`
  const receivables=canCredit?(await c.client.query(`SELECT r.id,o.number AS "orderNumber",r.due_date::text AS "dueDate",${openAmount} AS "openCents"`+eligibleBills+" ORDER BY r.due_date,r.id LIMIT 15 OFFSET $3",[c.tenantId,row.customer_id,offset])).rows:[]
  const totalBills=canCredit?(await c.client.query("SELECT count(*)::int AS n"+eligibleBills,[c.tenantId,row.customer_id])).rows[0]!.n:0
  const custody=(await c.client.query("SELECT "+custodySum+" AS q FROM warranty_settlements WHERE tenant_id=$1 AND case_id=$2",[c.tenantId,caseId])).rows[0]!.q
  const reviews=(await c.client.query('SELECT approval_id AS "approvalId" FROM warranty_settlement_reviews WHERE tenant_id=$1 AND case_id=$2',[c.tenantId,caseId])).rows
  return {tenantId:c.tenantId,canReview:c.permissions.includes(approve),reviews,revision:revisionValue(row.revision),originReady:valid,
    canBank,canCredit,canStock,accounts,totalBills,custody:decimal(n(custody),6),
    receivables:receivables.map(r=>({...r,openCents:n(r.openCents)})),
    movements:movements.map(m=>({...m,amountCents:m.amountCents==null?null:n(m.amountCents),
      quantityMicros:m.quantityMicros==null?null:n(m.quantityMicros),creditRemainingCents:m.creditRemainingCents==null?null:n(m.creditRemainingCents)}))}
}
async function stock(c:AuthorizedContext,headers:Headers,product:string,quantity:bigint,incoming:boolean,reason:string,settlementId:string) {
  const available=await c.client.query("SELECT status FROM products WHERE tenant_id=$1 AND id=$2",[c.tenantId,product])
  if(available.rows[0]?.status!=="active") conflict("O produto deve estar ativo no catálogo")
  if(incoming)await c.client.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,0) ON CONFLICT DO NOTHING",[c.tenantId,product])
  const prior=(await c.client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE",[c.tenantId,product])).rows[0]
  if(!prior || !incoming && n(prior.quantity_micros)-await heldQuantity(c,product)<quantity)return conflict("Estoque disponível insuficiente para a troca")
  const next=n(prior.quantity_micros)+(incoming?quantity:-quantity)
  if(next>999999999999999999n) conflict("Saldo de estoque acima do limite")
  const id=randomUUID(),direction=incoming?"receipt":"issue"
  await c.client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2",[c.tenantId,product,next])
  await c.client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,c.tenantId,product,direction,quantity,next,reason])
  await record(c,headers,"stock_movement",id,"stock.moved",{productId:product,direction,quantity:decimal(quantity,6),balanceAfter:decimal(next,6),warrantySettlementId:settlementId})
  return id
}
async function applyCredit(c:AuthorizedContext,headers:Headers,customer:unknown,caseId:string,input:Extract<Input,{kind:"apply_credit"}>,settlement:string) {
  const credit=(await c.client.query(`SELECT s.amount_cents-coalesce((SELECT sum(a.amount_cents) FROM warranty_settlements a WHERE a.tenant_id=s.tenant_id AND a.source_credit_id=s.id),0) AS remaining
    FROM warranty_settlements s WHERE s.tenant_id=$1 AND s.case_id=$2 AND s.id=$3 AND s.kind='credit'`,[c.tenantId,caseId,input.sourceCreditId])).rows[0]
  if(!credit || n(credit.remaining)<BigInt(input.amountCents)) conflict("Saldo do crédito insuficiente")
  const bill=(await c.client.query(`SELECT r.amount_cents,${openAmount} AS due,(SELECT p.id FROM receivable_payments p
    WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id AND p.kind='receipt' AND NOT EXISTS(SELECT FROM receivable_payments x WHERE x.tenant_id=p.tenant_id AND x.reverses_id=p.id)
    ORDER BY p.created_at DESC,p.id LIMIT 1) AS last_payment FROM receivables r JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id
    WHERE r.tenant_id=$1 AND r.id=$2 AND o.customer_id=$3 AND r.status='open' FOR UPDATE OF r`,[c.tenantId,input.receivableId,customer])).rows[0]
  const value=BigInt(input.amountCents)
  if(!bill||n(bill.due)<value) return conflict("O título deve pertencer ao cliente e ter saldo suficiente")
  const face=n(bill.amount_cents)-value,status=face===0n?"cancelled":n(bill.due)===value?"paid":"open"
  await c.client.query("UPDATE receivables SET amount_cents=$3,status=$4,payment_id=$5,revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,input.receivableId,face||bill.amount_cents,status,status==="paid"?bill.last_payment:null])
  await record(c,headers,"receivable",input.receivableId,"receivable.abated",{amountCents:input.amountCents,warrantySettlementId:settlement,creditId:input.sourceCreditId})
}
async function execute(c:AuthorizedContext,headers:Headers,caseId:string,expected:number|bigint,input:Input) {
  const currentCase=await current(c,"warranty_cases",caseId,expected)
  const deferred=["apply_credit","supplier_cash","supplier_stock"].includes(input.kind)
  if(currentCase.status==="cancelled" && input.kind!=="apply_credit" || currentCase.status==="closed" && !deferred)conflict("Protocolo encerrado para esta operação")
  validateDate(input.occurredOn)
  const {row,valid}=await origin(c,caseId)
  if(!valid) conflict("Vincule o cliente, pedido e item entregue à garantia")
  const previous=await c.client.query("SELECT 1 FROM warranty_settlements WHERE tenant_id=$1 AND case_id=$2 AND kind=$3 AND reference=$4",[c.tenantId,caseId,input.kind,input.reference])
  if(previous.rows.length)conflict("Referência já registrada para esta operação")
  const id=randomUUID(),scope=input.kind,quantity="quantity" in input?fixed(input.quantity,6):null
  let amount="amountCents" in input?BigInt(input.amountCents):null,entry:string|null=null,movement:string|null=null
  let authors:Record<string,unknown>|undefined
  if("approvalId" in input){
    const a=(await c.client.query(`SELECT a.action,a.decision,a.amount_cents,
      EXISTS(SELECT FROM warranty_settlements s WHERE s.tenant_id=a.tenant_id AND s.approval_id=a.id) AS used
      FROM warranty_approvals a WHERE a.tenant_id=$1 AND a.id=$2 AND a.case_id=$3`,[c.tenantId,input.approvalId,caseId])).rows[0]
    if(!a||scope!=="review"&&a.action!==scope||a.decision!=="approved"||a.used)return conflict("Selecione uma aprovação disponível desta garantia para a ação")
    authors=await decisionActors(c,caseId,input.approvalId)
    if(scope==="review"){
      if(authors.actor===authors.requester || authors.actor===authors.decider || authors.reviewer)conflict("A conferência exige outro aprovador e só pode ser registrada uma vez")
      await c.client.query("INSERT INTO warranty_settlement_reviews(tenant_id,approval_id,case_id,reviewer_id,reference) VALUES($1,$2,$3,$4,$5)",[c.tenantId,input.approvalId,caseId,authors.actor,input.reference])
      await bump(c,caseId)
      const data={id:input.approvalId,caseId,kind:"review",revision:nextRevision(expected),authors}
      await event(c,caseId,"approval",String(row.status),data)
      await record(c,headers,"warranty_approval",input.approvalId,"warranty.settlement.reviewed",data)
      return data
    }
    const checker=authors.reviewer??authors.decider
    if(checker===authors.requester)conflict("A decisão do solicitante exige conferência independente antes da execução")
    if(authors.actor===checker || authors.actor===authors.decider)conflict("O executor deve ser diferente dos aprovadores da decisão")
    if(scope!=="exchange"){
      amount=n(a.amount_cents)
      if(amount<=0n)conflict("A aprovação deve informar um valor positivo")
      const paid=n((await c.client.query("SELECT sum(amount_cents) AS amount FROM warranty_settlements WHERE tenant_id=$1 AND order_id=$2 AND line_number=$3 AND kind IN ('credit','refund')",[c.tenantId,row.order_id,row.line_number])).rows[0]!.amount)
      if(amount+paid+n(row.returned_amount)>n(row.amount_cents))conflict("O crédito, o reembolso e as devoluções superam o valor do item vendido")
    }
  }
  if("rmaId" in input){
    const rma=(await c.client.query(`SELECT r.status,r.supplier_id,EXISTS(SELECT FROM warranty_settlements s WHERE s.tenant_id=r.tenant_id AND s.rma_id=r.id) AS used
      FROM warranty_rmas r WHERE r.tenant_id=$1 AND r.id=$2 AND r.case_id=$3 FOR UPDATE`,[c.tenantId,input.rmaId,caseId])).rows[0]
    if(!rma || !["received","closed"].includes(String(rma.status)) || rma.used || rma.supplier_id && rma.supplier_id!==input.supplierId)return conflict("Confira o fornecedor e o recebimento do RMA antes de recuperar")
    const supplier=await c.client.query("SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND is_supplier AND status='active'",[c.tenantId,input.supplierId])
    if(!supplier.rows.length)conflict("Selecione um fornecedor ativo da empresa")
    if(!rma.supplier_id)await c.client.query("UPDATE warranty_rmas SET supplier_id=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,input.rmaId,input.supplierId])
  }
  if(quantity!==null) {
    const balances=(await c.client.query(`SELECT ${custodySum} AS custody, coalesce(sum(quantity_micros) FILTER(WHERE kind='exchange'),0) AS exchanged
      FROM warranty_settlements WHERE tenant_id=$1 AND order_id=$2 AND line_number=$3`,[c.tenantId,row.order_id,row.line_number])).rows[0]!
    const custody=n((await c.client.query("SELECT "+custodySum+" AS held FROM warranty_settlements WHERE tenant_id=$1 AND case_id=$2",[c.tenantId,caseId])).rows[0]!.held)
    const netDelivered=n(row.delivered)-n(row.returned_quantity)
    if(scope==="intake" && (quantity+n(balances.custody)>netDelivered || row.equipment_id && custody+quantity>1000000n))conflict("Quantidade em assistência supera o equipamento entregue")
    if(["repair_return","scrap","supplier_stock"].includes(scope) && quantity>custody)conflict("Quantidade supera o saldo em custódia deste protocolo")
    if(scope==="exchange" && (quantity+n(balances.exchanged)>netDelivered || row.equipment_id && quantity>1000000n))conflict("A troca supera a quantidade vendida")
    if(row.equipment_id && (scope==="intake" || scope==="exchange")){
      const serial=(await c.client.query("SELECT "+custodySum+" AS custody,coalesce(sum(quantity_micros) FILTER(WHERE kind='exchange'),0) AS exchanges FROM warranty_settlements WHERE tenant_id=$1 AND origin->>'equipmentId'=$2",[c.tenantId,row.equipment_id])).rows[0]!
      if(quantity+n(scope==="intake"?serial.custody:serial.exchanges)>1000000n)conflict("Quantidade superior à unidade identificada pela série")
    }
    if(input.kind==="repair_return"){
      const service=await c.client.query("SELECT 1 FROM warranty_service_orders WHERE tenant_id=$1 AND case_id=$2 AND id=$3 AND status IN ('in_repair','completed')",[c.tenantId,caseId,input.serviceOrderId])
      if(!service.rows.length)conflict("Selecione a ordem de serviço que realizou o reparo")
      if(custody===quantity)await c.client.query("UPDATE warranty_service_orders SET status='completed',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='in_repair'",[c.tenantId,input.serviceOrderId])
    }
    if(scope==="exchange"||scope==="supplier_stock")movement=await stock(c,headers,String(row.product_id),quantity,scope==="supplier_stock","Garantia "+row.protocol+" • "+input.reference,id)
  }
  if("accountId" in input){
    const account=await c.client.query("SELECT a.id"+accountFrom+" AND a.id=$2",[c.tenantId,input.accountId])
    if(!account.rows.length)conflict("Selecione uma conta ativa que não esteja em uso por um PDV aberto")
    if(input.kind==="refund"){
      const receipts=(await c.client.query(`SELECT (SELECT coalesce(sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END),0)
        FROM receivables r JOIN receivable_payments p ON p.tenant_id=r.tenant_id AND p.receivable_id=r.id WHERE r.tenant_id=$1 AND r.order_id=$2)
        - (SELECT coalesce(sum(amount_cents),0) FROM warranty_settlements WHERE tenant_id=$1 AND order_id=$2 AND kind='refund') AS balance`,[c.tenantId,row.order_id])).rows[0]!
      if(n(receipts.balance)<amount!)conflict("Reembolso excede o valor efetivamente recebido do pedido")
    }
    entry=randomUUID()
    const direction=input.kind==="refund"?"debit":"credit"
    await c.client.query("INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[entry,c.tenantId,input.accountId,direction,amount,input.occurredOn,"Garantia "+row.protocol,input.reference])
    await record(c,headers,"financial_account_entry",entry,"financial_account_entry.created",{accountId:input.accountId,amount:decimal(amount!,2),direction,warrantySettlementId:id})
  }
  if(input.kind==="apply_credit")await applyCredit(c,headers,row.customer_id,caseId,input,id)
  const source={approvalActors:authors,orderId:row.order_id,lineNumber:row.line_number,productId:row.product_id,customerId:row.customer_id,documentId:row.document_id,equipmentId:row.equipment_id,serialNumber:row.serial_number,lot:row.lot}
  await c.client.query(`INSERT INTO warranty_settlements(id,tenant_id,case_id,order_id,line_number,customer_id,product_id,approval_id,rma_id,service_order_id,supplier_id,source_credit_id,receivable_id,account_entry_id,stock_movement_id,kind,amount_cents,quantity_micros,occurred_on,reference,origin)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id,c.tenantId,caseId,row.order_id,row.line_number,row.customer_id,row.product_id,"approvalId" in input?input.approvalId:null,"rmaId" in input?input.rmaId:null,"serviceOrderId" in input?input.serviceOrderId:null,"supplierId" in input?input.supplierId:null,"sourceCreditId" in input?input.sourceCreditId:null,"receivableId" in input?input.receivableId:null,entry,movement,scope,amount,quantity,input.occurredOn,input.reference,source])
  await bump(c,caseId)
  const data={id,caseId,kind:scope,revision:nextRevision(expected),stockMovementId:movement,accountEntryId:entry,amountCents:amount,quantityMicros:quantity,origin:source}
  await event(c,caseId,"treated",String(row.status),data)
  await record(c,headers,"warranty_settlement",id,"warranty.settlement.recorded",data)
  return data
}
export function registerWarrantySettlements(app:FastifyInstance,deps:AccessDependencies) {
  const url=base+"/settlements"
  app.get<{Params:{id:string}}>(url,async(req,reply)=>{
    const body = await authorizeRequest(req,deps,async c=>{
      requirePermission(c,read)
      const {offset}=parse(z.strictObject({offset:queryInteger(0,1000000).default(0)}),req.query)
      return summary(c,parse(idParam,req.params.id),offset)
    })
    return reply.header("cache-control","no-store").header("etag",'"'+body.revision+'"').send(body)
  })
  app.post<{Params:{id:string}}>(url,async(req,reply)=>{
    const { body, replayed } = await authorizeRequest(req,deps,async c=>{
      requirePermission(c,read)
      const input=parse(command,req.body),id=parse(idParam,req.params.id)
      if(input.kind!=="review")requirePermission(c,manage)
      requirePermission(c,permission(input.kind))
      const revision=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"]),intent={id,revision,input},scope="warranty.settlement.recorded"
      const previous = await replay(c,key,scope,intent)
      if (previous) return { body: previous, replayed: true }
      const body={tenantId:c.tenantId,data:await execute(c,req.headers,id,revision,input)}
      await remember(c,key,scope,intent,body)
      return { body, replayed: false }
    })
    if (replayed) reply.header("idempotency-replayed","true")
    const data=body.data as {revision:number|bigint}
    return reply.header("cache-control","no-store").header("etag",'"'+data.revision+'"').send(body)
  })
}
