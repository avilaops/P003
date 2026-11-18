import {fiscalLots} from "./fiscal-lots.js"
import {eligiblePolicies,identification,policies,receiptOptions,traceInput,type Origin} from "./policy.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AccessDependencies,AuthorizedContext } from "../../platform/access.js"
import { command,conflict,idParam,invalid,limitedText,manage,parse,readWith } from "./shared.js"

const serial=limitedText(1,120)
const brazilDay="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
const origins=`SELECT d.id AS "documentId",o.id AS "orderId",o.number::text AS "orderNumber",d.number::text AS "invoiceNumber",o.customer_name AS "customerName",
  l.line_number AS "lineNumber",l.product_id AS "productId",l.name AS "productName",l.sku,p.category_id AS "categoryId",pc.name AS category,m.manufacturer,
  coalesce(co.channel,q.public_snapshot#>>'{input,channel}') AS channel,
  (d.issued_at::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date::text AS "soldOn",
  greatest(0, least(2147483647,l.quantity_micros / 1000000 - (SELECT coalesce(sum(e.units),0) FROM warranty_sold_equipment e WHERE e.tenant_id=o.tenant_id AND e.order_id=o.id AND e.line_number=l.line_number),COALESCE(i.quantity_micros / 1000000,floor(item.quantity)) -
    (SELECT coalesce(sum(e.units),0) FROM warranty_sold_equipment e WHERE e.tenant_id=d.tenant_id AND e.document_id=d.id AND e.line_number=l.line_number)))::int AS "availableUnits"
  FROM fiscal_nfe_documents d
  JOIN fiscal_nfe_drafts draft ON (draft.tenant_id,draft.id)=(d.tenant_id,d.id)
  LEFT JOIN sales_invoice_lots lot ON (lot.tenant_id,lot.draft_id)=(d.tenant_id,d.id)
  JOIN sales_orders o ON (o.tenant_id,o.id)=(d.tenant_id,COALESCE(lot.order_id,d.source_order_id))
  JOIN sales_order_lines l ON (l.tenant_id,l.order_id)=(o.tenant_id,o.id)
  LEFT JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id)
  LEFT JOIN product_categories pc ON (pc.tenant_id,pc.id)=(p.tenant_id,p.category_id)
  LEFT JOIN product_catalog_profiles m ON (m.tenant_id,m.product_id)=(p.tenant_id,p.id)
  LEFT JOIN commercial_order_quotes q ON (q.tenant_id,q.order_id)=(o.tenant_id,o.id)
  LEFT JOIN sales_channel_orders co ON (co.tenant_id,co.order_id)=(o.tenant_id,o.id)
  LEFT JOIN sales_invoice_lot_items i ON (i.tenant_id,i.lot_id,i.line_number)=(lot.tenant_id,lot.id,l.line_number)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN entry->>'quantity' ~ '^[0-9]{1,16}([.][0-9]{1,6})?$' THEN (entry->>'quantity')::numeric END AS quantity
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(draft.details->'items')='array' THEN draft.details->'items' ELSE '[]' END) WITH ORDINALITY AS fiscal(entry,position)
    WHERE entry->>'code'=l.sku AND position=(SELECT count(*) FROM sales_order_lines prior WHERE prior.tenant_id=l.tenant_id AND prior.order_id=l.order_id AND prior.line_number<=l.line_number)
  ) item ON lot.id IS NULL
  WHERE d.tenant_id=$1 AND d.status='authorized' AND d.environment='production' AND d.model=55
    AND (item.quantity>0 OR (i.lot_id IS NOT NULL AND NOT lot.withdrawn))`
const equipmentQuery=`SELECT e.id,e.serial_number AS "serialNumber",e.lot,e.units,e.policy_snapshot AS "policySnapshot",e.trace_snapshot AS "traceSnapshot",e.order_id AS "orderId",e.line_number AS "lineNumber",
    l.product_id AS "productId",l.name AS "productName",o.customer_id AS "customerId",o.customer_name AS "customerName",
    o.number::text AS "orderNumber",e.policy_id AS "policyId",d.id AS "documentId",d.number::text AS "invoiceNumber",
    e.sold_on::text AS "soldOn",(e.sold_on+e.warranty_days)::text AS "expiresOn",
    (e.sold_on+e.warranty_days)-${brazilDay} AS "remainingDays",
    CASE WHEN d.status<>'authorized' THEN 'rejected' WHEN e.sold_on+e.warranty_days < ${brazilDay} THEN 'expired' ELSE 'eligible' END AS "coverageStatus"
    FROM warranty_sold_equipment e JOIN sales_orders o ON (o.tenant_id,o.id)=(e.tenant_id,e.order_id)
    JOIN sales_order_lines l ON (l.tenant_id,l.order_id,l.line_number)=(e.tenant_id,e.order_id,e.line_number)
    JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(e.tenant_id,e.document_id)
    WHERE e.tenant_id=$1`
export async function findEquipment(ctx:AuthorizedContext,serialNumber:string) {
 return (await ctx.client.query(equipmentQuery+" AND upper(trim(e.serial_number))=upper(trim($2))",[ctx.tenantId,serialNumber])).rows[0]
}
type TraceLookup={serialNumber?:string|null|undefined;lot?:string|null|undefined;documentId?:string|null|undefined;lineNumber?:number|null|undefined;equipmentId?:string|null|undefined;orderId?:string|null|undefined;productId?:string|null|undefined}
async function traceMatches(c:AuthorizedContext,input:TraceLookup) {
 return (await c.client.query(equipmentQuery+` AND ($2::text IS NULL OR upper(trim(e.serial_number))=upper(trim($2)))
  AND ($3::text IS NULL OR upper(trim(e.lot))=upper(trim($3)))
  AND ($4::uuid IS NULL OR e.document_id=$4) AND ($5::int IS NULL OR e.line_number=$5) AND ($6::uuid IS NULL OR e.id=$6)
  AND ($7::uuid IS NULL OR e.order_id=$7) AND ($8::uuid IS NULL OR l.product_id=$8)
  ORDER BY e.created_at DESC,e.id`,[c.tenantId,input.serialNumber,input.lot,input.documentId,input.lineNumber,input.equipmentId,input.orderId,input.productId])).rows
}
export async function resolveCaseEquipment(c:AuthorizedContext,input:TraceLookup){
 if(!input.serialNumber&&!input.lot&&!input.equipmentId)return undefined
 const rows=await traceMatches(c,input)
 if(rows.length>1)return invalid("Há mais de uma origem deste lote. Selecione o equipamento fiscal correspondente")
 if(rows.length)return rows[0]
 const known=input.equipmentId||input.serialNumber&&await findEquipment(c,input.serialNumber)||input.lot&&(await traceMatches(c,{lot:input.lot})).length
 if(known)return invalid("Série, lote, pedido e nota devem corresponder ao mesmo equipamento vendido")
 return undefined
}
export async function invoiceLine(ctx:AuthorizedContext,doc:string,line:number) {
  return (await ctx.client.query<Origin>(origins+" AND d.id=$2 AND l.line_number=$3",[ctx.tenantId,doc,line])).rows[0]
}
export function registerWarrantyEquipment(app:FastifyInstance,deps:AccessDependencies) {
  app.get("/api/v1/warranty-equipment",async(req,reply)=>reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx=>{
    const f=parse(z.strictObject({serialNumber:serial.optional(),lot:serial.optional(),documentId:idParam.optional(),lineNumber:z.coerce.number().int().positive().optional()}).refine(v=>Boolean(v.serialNumber||v.lot)),req.query)
    const matches=await traceMatches(ctx,f)
    return {data:matches.length===1?matches[0]:null,matches}
  })))
  app.get("/api/v1/warranty-origins",async(req,reply)=>reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx=>{
    const f=parse(z.strictObject({orderId:idParam.optional(),documentId:idParam.optional(),q:limitedText(2,80).optional()}).refine(f=>Boolean(f.orderId || f.documentId || f.q)),req.query)
    const rows=await ctx.client.query(origins+` AND ($2::uuid IS NULL OR o.id=$2) AND ($3::uuid IS NULL OR d.id=$3) AND ($4::text IS NULL OR strpos(lower(concat_ws(' ',o.number,d.number,o.customer_name,l.sku,l.name)),lower($4))>0) ORDER BY d.issued_at DESC,d.number,l.line_number LIMIT 100`,[ctx.tenantId,f.orderId,f.documentId,f.q])
    return {data:rows.rows}
  })))
  const equipmentInput=z.strictObject({serialNumber:serial.optional(),lot:serial.optional(),units:z.number().int().min(1).max(1000000).default(1),
   documentId:idParam,lineNumber:z.number().int().positive(),policyId:idParam,trace:traceInput.default({})}).refine(v=>Boolean(v.serialNumber||v.lot)&&(!v.serialNumber||v.units===1))
  command(app,deps,"/api/v1/warranty-equipment",equipmentInput,"warranty.equipment.registered","warranty_equipment",manage,async(ctx,input)=>{
    const line=await invoiceLine(ctx,input.documentId,input.lineNumber)
    if (!line) return invalid("Selecione um item de nota de venda autorizada em produção")
    if (Number(line.availableUnits)<input.units) conflict("Quantidade superior às unidades faturadas disponíveis para identificação")
    const batches=await fiscalLots(ctx,line)
    const batch=batches.find(b=>b.lot.toLowerCase()===input.lot?.toLowerCase())
    if(batches.length&&!batch)return invalid("Identifique o lote constante no item da NF-e")
    if(batch&&batch.availableUnits<input.units)conflict("Quantidade excede as unidades disponíveis no lote fiscal")
    if(input.lot&&!batch&&!input.trace.reference)return invalid("Informe a procedência do lote declarado")
    const receipts=await receiptOptions(ctx,line),trace=identification(line,input.trace,receipts)
    const policy=eligiblePolicies(await policies(ctx),trace,line.soldOn).find(p=>p.id===input.policyId)
    if (!policy) return invalid("Selecione uma política vigente para a origem e data da venda")
    const id=randomUUID()
    await ctx.client.query(`INSERT INTO warranty_sold_equipment(tenant_id,id,serial_number,lot,units,order_id,line_number,document_id,policy_id,warranty_days,sold_on,policy_snapshot,trace_snapshot)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[ctx.tenantId,id,input.serialNumber,input.lot,input.units,line.orderId,line.lineNumber,line.documentId,policy.id,policy.durationDays,line.soldOn,policy,{...trace,lotSource:batch?"NF-e autorizada":input.lot?"declaração":null,registeredBy:ctx.authSubject}])
    return {data:{...(await traceMatches(ctx,{equipmentId:id}))[0],revision:1},aggregateId:id}
  })
}
