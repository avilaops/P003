import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { type AccessDependencies, type AuthorizedContext, authorizeRequest, requirePermission } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { queryInteger, searchQuery } from "../registrations/query.js"
import { decimal } from "../sales/fixed.js"
import { registerSerialHistory } from "./serial-history.js"

const serial = z.string().trim().min(1).max(120)
export const serialList = z.array(serial).min(1).max(10000).refine(values => new Set(values).size === values.length)
const kind = z.enum(["sale","purchase","production","count","pos"])
const configure = z.strictObject({ productId: id, opening: z.array(z.strictObject({
  warehouseId: id, orderId: id.optional(), serials: serialList,
})).max(10000) })
const assign = z.strictObject({ productId: id, documentId: id, kind, direction: z.enum(["receipt","issue"]),
  serials: serialList, revision: z.number().int().nonnegative().default(0) })
const page = z.strictObject({ q: searchQuery, productId: id.optional(), documentId: id.optional(),
  limit: queryInteger(1,100).default(25), offset: queryInteger(0,100000).default(0) })
type Headers = Record<string,string|string[]|undefined>
const missing = () => new Problem(404,"not_found","Produto ou documento não encontrado na empresa")
const conflict = (message:string) => new Problem(409,"domain_conflict",message)
const invalid = () => new Problem(422,"invalid_input","Confira depósito, documento e números de série")

async function product(ctx:AuthorizedContext, productId:string) {
  const row = (await ctx.client.query(`SELECT p.id,p.sku,p.name,p.status,s.product_id IS NOT NULL AS tracked
    FROM products p LEFT JOIN stock_serial_products s ON (s.tenant_id,s.product_id)=(p.tenant_id,p.id)
    WHERE p.tenant_id=$1 AND p.id=$2`,[ctx.tenantId,productId])).rows[0]
  if (!row) throw missing()
  return row
}
async function openingPositions(ctx:AuthorizedContext, productId:string) {
  return (await ctx.client.query(`WITH held AS (SELECT warehouse_id,order_id,quantity_micros FROM stock_location_reservations
    WHERE tenant_id=$1 AND product_id=$2), stock AS (SELECT warehouse_id,quantity_micros FROM stock_positions WHERE tenant_id=$1 AND product_id=$2)
    SELECT w.id AS "warehouseId",w.name,NULL::uuid AS "orderId",s.quantity_micros-coalesce((SELECT sum(h.quantity_micros)
      FROM held h WHERE h.warehouse_id=w.id),0) AS quantity FROM stock s JOIN warehouses w ON w.tenant_id=$1 AND w.id=s.warehouse_id
    UNION ALL SELECT w.id,w.name,h.order_id,h.quantity_micros FROM held h JOIN warehouses w ON w.tenant_id=$1 AND w.id=h.warehouse_id
    ORDER BY 2,3`,[ctx.tenantId,productId])).rows.filter(row=>BigInt(String(row.quantity))!==0n)
}
async function enable(ctx:AuthorizedContext, headers:Headers, body:unknown) {
  requirePermission(ctx,"inventory.stock.manage")
  const parsed=configure.safeParse(body)
  if(!parsed.success) throw invalid()
  const input=parsed.data, key=commandKey(headers["idempotency-key"]), scope="stock.serials.enabled"
  const previous=await replay(ctx,key,scope,input)
  if(previous) return previous
  const p=await product(ctx,input.productId)
  if(p.tracked || p.status!=="active") throw conflict("O controle já está ativo ou o produto está arquivado")
  const required=await openingPositions(ctx,input.productId)
  const keyFor=(warehouse:unknown,order:unknown)=>String(warehouse)+"/"+String(order??"")
  const opening=new Map(input.opening.map(group=>[keyFor(group.warehouseId,group.orderId),group.serials]))
  const all=input.opening.flatMap(group=>group.serials)
  if(opening.size!==input.opening.length || new Set(all).size!==all.length || required.length!==opening.size ||
     required.some(row=>BigInt(opening.get(keyFor(row.warehouseId,row.orderId))?.length??0)*1000000n!==BigInt(String(row.quantity))))
    throw conflict("Identifique cada unidade do saldo de abertura e das reservas por depósito")
  await ctx.client.query("INSERT INTO stock_serial_products(tenant_id,product_id) VALUES($1,$2)",[ctx.tenantId,input.productId])
  for(const group of input.opening) {
    await ctx.client.query(`WITH opened AS (INSERT INTO stock_serials(tenant_id,product_id,serial,warehouse_id,status,reserved_order_id)
      SELECT $1,$2,s,$3,CASE WHEN $4::uuid IS NULL THEN 'available' ELSE 'reserved' END,$4 FROM unnest($5::text[]) s RETURNING *)
      INSERT INTO stock_serial_events(tenant_id,product_id,serial,warehouse_id,status,order_id)
        SELECT tenant_id,product_id,serial,warehouse_id,status,reserved_order_id FROM opened`,[ctx.tenantId,input.productId,group.warehouseId,group.orderId,group.serials])
    if(group.orderId) await ctx.client.query(`INSERT INTO stock_serial_assignments(tenant_id,product_id,kind,document_id,direction,serials)
      VALUES($1,$2,'sale',$3,'issue',$4)`,[ctx.tenantId,input.productId,group.orderId,group.serials])
  }
  const result={tenantId:ctx.tenantId,productId:input.productId,tracked:true,identified:all.length}
  await record(ctx,headers,"product",input.productId,scope,result)
  await remember(ctx,key,scope,input,result)
  return result
}
const documents = {
  sale: ["sales.orders.manage", "SELECT 1 FROM sales_order_lines l JOIN sales_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id) WHERE l.tenant_id=$1 AND l.product_id=$2 AND o.id=$3 AND o.status IN ('draft','accepted') AND $4='issue'"],
  purchase:["purchasing.orders.manage","SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id) WHERE l.tenant_id=$1 AND l.product_id=$2 AND o.id=$3 AND o.status IN ('confirmed','partially_received') AND $4='receipt'"],
  production:["production.manage","SELECT 1 FROM production_orders WHERE tenant_id=$1 AND id=$3 AND status='open' AND ($4='issue' OR product_id=$2)"],
  count:["inventory.counts.manage","SELECT 1 FROM inventory_count_lines l JOIN inventory_counts c ON (c.tenant_id,c.id)=(l.tenant_id,l.count_id) WHERE l.tenant_id=$1 AND l.product_id=$2 AND c.id=$3 AND c.status='open' AND $4 IN ('issue','receipt')"],
  pos:["sales.pos.manage","SELECT 1 FROM pos_sessions WHERE tenant_id=$1 AND id=$3 AND status='open' AND $2::uuid IS NOT NULL AND $4='issue'"],
} as const

async function assignDocument(ctx:AuthorizedContext,headers:Headers,body:unknown) {
  const parsed=assign.safeParse(body)
  if(!parsed.success) throw invalid()
  const input=parsed.data,[permission,query]=documents[input.kind]
  requirePermission(ctx,permission)
  const key=commandKey(headers["idempotency-key"]),scope="stock.serials.assigned"
  const prior=await replay(ctx,key,scope,input)
  if(prior) return prior
  const p=await product(ctx,input.productId)
  if(!p.tracked) throw conflict("Ative o controle de série do produto")
  if(!(await ctx.client.query(query,[ctx.tenantId,input.productId,input.documentId,input.direction])).rows.length) throw missing()
  const existing=(await ctx.client.query("SELECT serial,status FROM stock_serials WHERE tenant_id=$1 AND product_id=$2 AND serial=ANY($3::text[])",[ctx.tenantId,input.productId,input.serials])).rows
  if(input.direction==="issue" ? existing.length!==input.serials.length || existing.some(s=>s.status!=="available") : existing.length>0)
    throw conflict("Série já utilizada ou indisponível para este documento")
  const args=[ctx.tenantId,input.productId,input.kind,input.documentId,input.direction,input.serials,input.revision]
  const {rows}=await ctx.client.query(`INSERT INTO stock_serial_assignments AS a(tenant_id,product_id,kind,document_id,direction,serials)
    SELECT $1,$2,$3,$4,$5,$6 WHERE $7::integer=0 OR EXISTS (SELECT 1 FROM stock_serial_assignments WHERE tenant_id=$1
      AND product_id=$2 AND kind=$3 AND document_id=$4 AND direction=$5 AND revision=$7)
    ON CONFLICT(tenant_id,product_id,kind,document_id,direction) DO UPDATE SET serials=excluded.serials,revision=a.revision+1
      WHERE a.revision=$7 OR (cardinality(a.serials)=0 AND $7=0) RETURNING revision`,args)
  if(!rows.length) throw new Problem(412,"revision_conflict","A seleção de séries mudou. Consulte a revisão atual")
  const result={tenantId:ctx.tenantId,...input,revision:Number(rows[0]!.revision)}
  await record(ctx,headers,"stock_document",input.documentId,scope,result)
  await remember(ctx,key,scope,input,result)
  return result
}

export function registerSerials(app:FastifyInstance, deps:AccessDependencies) {
  registerSerialHistory(app,deps)
  const base="/api/v1/stock/serials"
  for(const [path,command] of [["configure",enable],["assign",assignDocument]] as const) {
    app.post(base+"/"+path,async(req,reply)=>{
      const result=await authorizeRequest(req,deps,ctx=>{requirePermission(ctx,"inventory.stock.read");return command(ctx,req.headers,req.body)})
      return reply.header("cache-control","no-store").header("etag",'"'+String("revision" in result ? result.revision : 1)+'"').send(result)
    })
  }
  app.get(base,(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,async ctx=>{
      requirePermission(ctx,"inventory.stock.read")
      const parsed=page.safeParse(req.query)
      if(!parsed.success) throw invalid()
      const {q,productId,documentId,offset,limit}=parsed.data
      const sales=ctx.permissions.includes("sales.orders.read"), fiscal=ctx.permissions.includes("fiscal.nfe.read")
      const p=productId ? await product(ctx,productId) : null
      const {rows}=await ctx.client.query(`SELECT s.serial,s.status,w.name AS warehouse,p.sku,p.name,p.id AS "productId",
          CASE WHEN $7 THEN coalesce(s.reserved_order_id,e.order_id) END AS "orderId",CASE WHEN $7 THEN o.customer_name END AS customer,
          e.occurred_at AS "saleDate",CASE WHEN $8 THEN f.number END AS "invoiceNumber",CASE WHEN $8 THEN f.id END AS "invoiceId",
          CASE WHEN $8 THEN f.series END AS "invoiceSeries" FROM stock_serials s JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id)
        JOIN warehouses w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id)
        LEFT JOIN LATERAL(SELECT * FROM stock_serial_events e WHERE (e.tenant_id,e.product_id,e.serial)=(s.tenant_id,s.product_id,s.serial)
          AND e.status='sold' ORDER BY e.id DESC LIMIT 1) e ON true
        LEFT JOIN sales_orders o ON (o.tenant_id,o.id)=(e.tenant_id,e.order_id)
        LEFT JOIN LATERAL(SELECT f.id,f.number,f.series FROM fiscal_nfe_documents f WHERE f.tenant_id=e.tenant_id AND f.source_order_id=e.order_id
          AND f.status='authorized' ORDER BY (f.environment='production') DESC,f.created_at DESC LIMIT 1) f ON true
        WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR p.id=$2) AND (strpos(lower(s.serial),lower($3))>0 OR strpos(lower(p.sku),lower($3))>0)
          AND ($4::uuid IS NULL OR (($7 OR $8) AND EXISTS(SELECT 1 FROM stock_serial_events doc
            WHERE (doc.tenant_id,doc.product_id,doc.serial)=(s.tenant_id,s.product_id,s.serial) AND doc.order_id=$4)))
        ORDER BY s.serial,p.sku,p.id LIMIT $5 OFFSET $6`,[ctx.tenantId,productId,q,documentId,limit+1,offset,sales,fiscal])
      const canEdit=ctx.permissions.includes("inventory.stock.manage")
      const opening=p && !p.tracked && canEdit ? (await openingPositions(ctx,productId!)).map(row=>({...row,quantity:decimal(BigInt(String(row.quantity)),6)})) : []
      const assignmentKinds=Object.entries(documents).filter(([,doc])=>ctx.permissions.includes(doc[0])).map(([key])=>key)
      const selections=productId && documentId ? (await ctx.client.query(`SELECT kind,direction,serials,revision FROM stock_serial_assignments
        WHERE tenant_id=$1 AND product_id=$2 AND document_id=$3 AND kind=ANY($4::text[])`,[ctx.tenantId,productId,documentId,assignmentKinds])).rows : []
      return {tenantId:ctx.tenantId,canEdit,product:p,opening,assignmentKinds,selections,data:rows.slice(0,limit),hasMore:rows.length>limit,offset}
    })
  })
}
