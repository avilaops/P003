import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AccessDependencies, AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { registerWarrantyService } from "./service.js"
import { registerWarrantyMaterials } from "./materials.js"
import { registerWarrantyRecords } from "./records.js"
import { registerWarrantyMetrics } from "./metrics.js"
import { caseEquipmentAndSale, resolveCaseEquipment, invoiceLine, registerWarrantyEquipment } from "./equipment.js"
import { queryInteger, searchQuery } from "../registrations/query.js"
import { command, criticalities, event, idParam, invalid, limitedText, manage, parse, readWith, statuses } from "./shared.js"

const caseUrl = "/api/v1/warranty-cases"
const createInput = z.strictObject({
  title: limitedText(3,160), description: limitedText(15,10000), criticality: criticalities,
  customerId: idParam.nullish(), productId: idParam.nullish(), policyId: idParam.nullish(), orderId: idParam.nullish(),
  equipmentId:idParam.nullish(),lot: limitedText(1,120).nullish(), serialNumber: limitedText(1,120).nullish(),
  documentId:idParam.nullish(),lineNumber:z.number().int().positive().nullish(),
})
const listQuery = z.strictObject({ q: searchQuery, status: statuses.optional(), criticality: criticalities.optional(),
  queue: limitedText(1,80).optional(), assignedTo: idParam.optional(), offset: queryInteger(0,1000000).default(0), limit: queryInteger(1,100).default(25) })
const projection = `wc.id,wc.protocol,wc.title,wc.description,wc.criticality,wc.status,wc.coverage_status AS "coverageStatus",
  wc.customer_id AS "customerId",c.legal_name AS "customerName",wc.product_id AS "productId",p.name AS "productName",
  wc.order_id AS "orderId",o.number::text AS "orderNumber",wc.policy_id AS "policyId",wc.serial_number AS "serialNumber",wc.document_id AS "documentId",wc.line_number AS "lineNumber",d.number::text AS "invoiceNumber",
  wc.equipment_id AS "equipmentId",wc.lot,wc.queue,wc.assigned_to AS "assignedTo",s.name AS "assignedToName",wc.sla_due_at AS "slaDueAt",
  wc.revision,wc.created_at AS "createdAt",wc.updated_at AS "updatedAt"`
const joins = ` FROM warranty_cases wc
  LEFT JOIN parties c ON (c.tenant_id,c.id)=(wc.tenant_id,wc.customer_id)
  LEFT JOIN products p ON (p.tenant_id,p.id)=(wc.tenant_id,wc.product_id)
  LEFT JOIN staff s ON (s.tenant_id,s.id)=(wc.tenant_id,wc.assigned_to)
  LEFT JOIN sales_orders o ON (o.tenant_id,o.id)=(wc.tenant_id,wc.order_id)
  LEFT JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(wc.tenant_id,wc.document_id) `
const selection = "SELECT " + projection + joins
async function load(ctx: AuthorizedContext,id: string) {
  const row = (await ctx.client.query("SELECT to_jsonb(row) AS data FROM (" + selection + "WHERE wc.tenant_id=$1 AND wc.id=$2) row",[ctx.tenantId,id])).rows[0]
  if (!row) throw new Problem(404,"not_found","Garantia não encontrada")
  return row.data as Record<string, unknown>
}
const children = {
  timeline: 'SELECT id,event_type AS "eventType",status,details,created_at AS "createdAt" FROM warranty_case_events',
  serviceOrders: 'SELECT id,status,diagnosis,report,scheduled_at AS "scheduledAt",completed_at AS "completedAt",labor_cents AS "laborCents",revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM warranty_service_orders',
  approvals: 'SELECT id,action,decision,amount_cents AS "amountCents",notes,created_at AS "createdAt" FROM warranty_approvals',
  rmas: 'SELECT id,reference,status,supplier_id AS "supplierId",carrier,tracking_code AS "trackingCode",notes,revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM warranty_rmas',
  quarantines: 'SELECT id,product_id AS "productId",quantity_micros AS "quantityMicros",stock_movement_id AS "stockMovementId",release_movement_id AS "releaseMovementId",status,reason,revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM warranty_quarantines',
}
export function registerWarranties(app: FastifyInstance,deps: AccessDependencies) {
  registerWarrantyService(app,deps)
  registerWarrantyMaterials(app,deps)
  registerWarrantyRecords(app,deps)
  registerWarrantyMetrics(app,deps)
  registerWarrantyEquipment(app,deps)
  app.get(caseUrl, async (request,reply) => reply.header("cache-control","no-store").send(await readWith(request,deps,async ctx => {
    const f = parse(listQuery,request.query)
    const where = `WHERE wc.tenant_id=$1
      AND ($2='' OR strpos(lower(concat_ws(' ',wc.protocol,wc.title,wc.serial_number,wc.lot,c.legal_name,p.name,p.sku,o.number,s.name)),lower($2))>0)
      AND ($4::text IS NULL OR wc.criticality=$4)
      AND ($5::text IS NULL OR wc.queue=$5) AND ($6::uuid IS NULL OR wc.assigned_to=$6)`
    const result = await ctx.client.query("WITH population AS (" + selection + where + `), stages AS (SELECT status,count(*)::int AS n FROM population GROUP BY status),
      matches AS (SELECT * FROM population WHERE $3::text IS NULL OR status=$3),
      page AS (SELECT * FROM matches ORDER BY "updatedAt" DESC,id DESC LIMIT $7 OFFSET $8)
      SELECT (SELECT count(*)::int FROM matches) AS total,COALESCE((SELECT jsonb_object_agg(status,n) FROM stages),'{}') AS counts,
      COALESCE(jsonb_agg(to_jsonb(page) ORDER BY "updatedAt" DESC,id DESC),'[]') AS data FROM page`,
      [ctx.tenantId,f.q,f.status,f.criticality,f.queue,f.assignedTo,f.limit,f.offset])
    return { ...result.rows[0], limit: f.limit, offset: f.offset }
  })))
  app.get<{Params:{id:string}}>(caseUrl+"/:id",async (request,reply) => {
    const result = await readWith(request,deps,async ctx => {
      const id = parse(idParam,request.params.id)
      const data = await load(ctx,id)
      const equipment = data.equipmentId ? await resolveCaseEquipment(ctx,{equipmentId:String(data.equipmentId)}) : null
      data.equipment = equipment?.id === data.equipmentId ? equipment : null
      for (const [name,sql] of Object.entries(children)) {
        const rows = await ctx.client.query("SELECT to_jsonb(t) AS data FROM (" + sql + " WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at,id) t",[ctx.tenantId,id])
        data[name] = rows.rows.map(row => row.data)
      }
      const parts = await ctx.client.query('SELECT to_jsonb(t) AS data FROM (SELECT p.id,p.service_order_id AS "serviceOrderId",p.product_id AS "productId",p.product_name AS "productName",p.sku,p.quantity_micros AS "quantityMicros",p.amount_cents AS "amountCents",p.created_at AS "createdAt",m.serial_numbers AS "serialNumbers",m.warehouse_id AS "warehouseId",w.name AS "warehouseName" FROM warranty_service_order_parts p JOIN warranty_service_orders so ON (so.tenant_id,so.id)=(p.tenant_id,p.service_order_id) LEFT JOIN stock_movements m ON (m.tenant_id,m.id)=(p.tenant_id,p.stock_movement_id) LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(m.tenant_id,m.warehouse_id) WHERE p.tenant_id=$1 AND so.case_id=$2 ORDER BY p.created_at,p.id) t',[ctx.tenantId,id])
      data.parts = parts.rows.map(row=>row.data)
      return { data }
    })
    return reply.header("cache-control","no-store").header("etag",'"'+String(result.data.revision)+'"').send(result)
  })
  command(app,deps,caseUrl,createInput,"warranty.case.opened","warranty_case",manage,async (ctx,input) => {
    if(Boolean(input.documentId)!==Boolean(input.lineNumber)) invalid("Informe a nota e o item de origem")
    const fiscal=input.documentId && input.lineNumber ? await invoiceLine(ctx,input.documentId,input.lineNumber) : undefined
    if(input.documentId && (!fiscal || input.productId && input.productId!==fiscal.productId || input.orderId && input.orderId!==fiscal.orderId)) invalid("A nota e o item devem corresponder ao equipamento vendido")
    const {equipment,sale}=await caseEquipmentAndSale(ctx,{...input,productId:input.productId??fiscal?.productId,orderId:input.orderId??fiscal?.orderId})
    if (equipment) {
      for (const field of ["orderId","productId","customerId","policyId","documentId","lineNumber"] as const) {
        if (input[field] && input[field] !== equipment[field]) invalid("A origem informada difere do equipamento vendido")
      }
    }
    if(sale && input.customerId && input.customerId!==sale.customerId)invalid("O cliente informado diverge do titular da série entregue")
    const resolved={...input,...fiscal,...sale,...equipment}
    const refs = (await ctx.client.query(`SELECT
      (SELECT customer_id FROM sales_orders WHERE tenant_id=$1 AND id=$2) AS customer,
      ($3::uuid IS NULL OR EXISTS(SELECT FROM parties WHERE tenant_id=$1 AND id=$3 AND is_customer)) AS party,
      ($4::uuid IS NULL OR EXISTS(SELECT FROM products WHERE tenant_id=$1 AND id=$4)) AS product,
      ($5::uuid IS NULL OR EXISTS(SELECT FROM warranty_policies WHERE tenant_id=$1 AND id=$5 AND status='active')) AS policy,
      ($2::uuid IS NULL OR $4::uuid IS NULL OR EXISTS(SELECT FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2 AND product_id=$4)) AS line`,[ctx.tenantId,resolved.orderId,resolved.customerId,resolved.productId,equipment ? null : input.policyId])).rows[0]!
    if (!refs.party || !refs.product || !refs.policy || !refs.line || resolved.orderId && (!refs.customer || resolved.customerId && resolved.customerId !== refs.customer)) invalid("Confira os vínculos entre pedido, cliente, produto e política da garantia")
    const id = randomUUID()
    await ctx.client.query("INSERT INTO warranty_cases(id,tenant_id,protocol,title,description,criticality,customer_id,order_id,product_id,policy_id,serial_number,lot,equipment_id,coverage_status,document_id,line_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
      [id,ctx.tenantId,"GAR-"+id.replaceAll("-",""),input.title,input.description,input.criticality,resolved.customerId ?? refs.customer,resolved.orderId,resolved.productId,resolved.policyId,equipment?.serialNumber??sale?.serialNumber??input.serialNumber,equipment?.lot??input.lot,equipment?.id,equipment?.coverageStatus ?? "pending",resolved.documentId,resolved.lineNumber])
    await event(ctx,id,"opened","opened",{ title:input.title })
    return { data:await load(ctx,id),aggregateId:id }
  })
}
