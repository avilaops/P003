import {randomUUID} from "node:crypto"
import type {AuthorizedContext} from "../../platform/access.js"
import {requirePermission} from "../../platform/access.js"
import {record} from "../../platform/commands.js"
import {Problem} from "../../platform/problem.js"
import {revisionValue} from "../../platform/revision.js"
import {decimal} from "../sales/fixed.js"
import {moneyFromMicros} from "../inventory/valuation.js"

export type Headers=Record<string,string|string[]|undefined>
export const missing=()=>new Problem(404,"not_found","Registro de produção não encontrado nesta empresa")
export const conflict=(reason:string)=>new Problem(409,"domain_conflict",reason)
export const invalid=(reason:string)=>new Problem(422,"invalid_input",reason)
export const stale=()=>new Problem(412,"revision_conflict","A revisão mudou. Recarregue o registro")
export const qty=(value:unknown)=>decimal(BigInt(String(value)),6)
export function stockPermission(ctx:AuthorizedContext){
  requirePermission(ctx,"inventory.stock.read")
  requirePermission(ctx,"inventory.stock.manage")
}
export async function history(ctx:AuthorizedContext,headers:Headers,id:string,action:string,details:object){
  await ctx.client.query(`INSERT INTO production_history(id,tenant_id,production_order_id,action,stage_id,stage_name,actor_subject,details)
    SELECT $1,$2,o.id,$4,s.id,s.name,$5,$6 FROM production_orders o JOIN production_stages s ON (s.tenant_id,s.id)=(o.tenant_id,o.stage_id)
    WHERE o.tenant_id=$2 AND o.id=$3`,[randomUUID(),ctx.tenantId,id,action,ctx.authSubject,details])
  await record(ctx,headers,"production_order",id,action,details)
}
export async function defaults(ctx:AuthorizedContext){
  await ctx.client.query(`INSERT INTO production_stages(id,tenant_id,name,position,kind)
    SELECT gen_random_uuid(),$1,name,pos,kind FROM (VALUES ('A produzir',1,'andamento'),('Corte',2,'andamento'),
    ('Solda',3,'andamento'),('Pintura',4,'andamento'),('Montagem',5,'andamento'),('Pronto',1,'pronta')) AS d(name,pos,kind)
    WHERE NOT EXISTS(SELECT 1 FROM production_stages WHERE tenant_id=$1) ON CONFLICT DO NOTHING`,[ctx.tenantId])
}
const today="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
const projection=`SELECT o.id,o.order_id AS "orderId",o.product_id AS "productId",o.sku,o.name,o.unit,o.quantity_micros,
  o.stage_id AS "stageId",s.name AS "stageName",s.kind AS "stageKind",o.status,o.revision,o.finished_at AS "finishedAt",o.cancelled_at AS "cancelledAt",
  o.cancellation_id AS "cancellationId",o.bom_version AS "bomVersion",o.warehouse_id AS "warehouseId",
  schedule.planned_on::text AS "plannedOn",schedule.planned_on IS NOT NULL AND schedule.planned_on<${today} AND o.status='open' AS overdue,
  ${today}-(coalesce((SELECT max(h.created_at) FROM production_history h WHERE h.tenant_id=o.tenant_id AND h.production_order_id=o.id
    AND h.action='production.stage_changed'),o.created_at) AT TIME ZONE 'America/Sao_Paulo')::date AS "daysInStage",
  sale.customer_name AS customer,sale.number::text AS "orderNumber"
  FROM production_orders o JOIN production_stages s ON (s.tenant_id,s.id)=(o.tenant_id,o.stage_id)
  JOIN sales_orders sale ON (sale.tenant_id,sale.id)=(o.tenant_id,o.order_id)
  LEFT JOIN sales_order_checkouts c ON (c.tenant_id,c.order_id)=(o.tenant_id,o.order_id)
  CROSS JOIN LATERAL(SELECT coalesce(o.planned_on,(c.created_at AT TIME ZONE 'America/Sao_Paulo')::date+c.manufacturing_days) AS planned_on) schedule`
const job=(row:Record<string,unknown>)=>{
  const {quantity_micros,...data}=row
  return {...data,revision:revisionValue(row.revision),quantity:qty(quantity_micros)}
}
export async function load(ctx:AuthorizedContext,id:string){
  const result=await ctx.client.query(projection+" WHERE o.tenant_id=$1 AND o.id=$2",[ctx.tenantId,id])
  if(!result.rows[0])throw missing()
  return job(result.rows[0])
}
export async function listOrders(ctx:AuthorizedContext,query:{orderId?:string|undefined;offset:number;limit:number}){
  const args=[ctx.tenantId,query.orderId]
  const where=" WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.order_id=$2)"
  const rows=await ctx.client.query(projection+where+" ORDER BY o.created_at DESC,o.id DESC LIMIT $3 OFFSET $4",[...args,query.limit,query.offset])
  const total=(await ctx.client.query("SELECT count(*) AS total FROM production_orders o"+where,args)).rows[0]!.total
  return {tenantId:ctx.tenantId,canEdit:ctx.permissions.includes("production.manage"),data:rows.rows.map(job),total:Number(total),offset:query.offset,limit:query.limit}
}
export async function stages(ctx:AuthorizedContext){
  const {rows}=await ctx.client.query("SELECT id,name,kind,position,revision FROM production_stages WHERE tenant_id=$1 ORDER BY (kind='pronta'),position,id",[ctx.tenantId])
  return {tenantId:ctx.tenantId,canEdit:ctx.permissions.includes("production.manage"),data:rows.map(s=>({...s,revision:revisionValue(s.revision)}))}
}
export async function structure(ctx:AuthorizedContext,productId:string){
  const p=(await ctx.client.query("SELECT id,name,sku,unit,status FROM products WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,productId])).rows[0]
  if(!p)throw missing()
  const rows=(await ctx.client.query(`SELECT b.version,b.created_at AS "createdAt",b.created_by AS actor,i.component_id AS "productId",p.sku,p.name,p.unit,i.per_unit_micros
    FROM production_structures b JOIN production_structure_items i USING(tenant_id,product_id,version)
    JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.component_id) WHERE b.tenant_id=$1 AND b.product_id=$2 ORDER BY b.version DESC,p.sku,p.id`,[ctx.tenantId,productId])).rows
  return {tenantId:ctx.tenantId,product:p,canEdit:ctx.permissions.includes("production.manage"),version:Number(rows[0]?.version??0),
    components:rows.map(({per_unit_micros,...r})=>({...r,quantity:qty(per_unit_micros)}))}
}
export async function detail(ctx:AuthorizedContext,id:string){
  await ctx.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE",[ctx.tenantId])
  const args=[ctx.tenantId,id],data=await load(ctx,id)
  const events=await ctx.client.query(`SELECT id,action,stage_name AS "stageName",actor_subject AS actor,details,created_at AS "createdAt"
    FROM production_history WHERE tenant_id=$1 AND production_order_id=$2 ORDER BY created_at,id`,args)
  const consumed=await ctx.client.query(`SELECT c.stock_movement_id AS id,c.product_id AS "productId",c.sku,c.name,c.unit,c.quantity_micros,
    c.unit_cost_cents,c.amount_cents,EXISTS(SELECT 1 FROM stock_movements m WHERE m.tenant_id=c.tenant_id AND m.reverses_id=c.stock_movement_id) AS reversed
    FROM production_consumptions c WHERE c.tenant_id=$1 AND c.production_order_id=$2 ORDER BY c.created_at,c.stock_movement_id`,args)
  const planned=await ctx.client.query(`SELECT i.component_id AS "productId",p.sku,p.name,p.unit,i.per_unit_micros,div(i.per_unit_micros::numeric*o.quantity_micros+999999,1000000) total,
    coalesce(r.quantity_micros,0) held FROM production_orders o JOIN production_structure_items i ON (i.tenant_id,i.product_id,i.version)=(o.tenant_id,o.product_id,o.bom_version)
    JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.component_id) LEFT JOIN production_component_reservations r ON (r.tenant_id,r.production_order_id,r.product_id)=(o.tenant_id,o.id,i.component_id)
    WHERE o.tenant_id=$1 AND o.id=$2 ORDER BY p.sku,p.id`,args)
  const batches=await ctx.client.query(`SELECT p.id,p.receipt_id AS "receiptId",p.produced_micros,p.loss_micros,p.minutes,p.value_micros,p.additional_cents,p.actor,p.reason,
    p.created_at AS "createdAt",r.posting_id IS NOT NULL AS reversed FROM production_postings p LEFT JOIN production_posting_reversals r
    ON (r.tenant_id,r.posting_id)=(p.tenant_id,p.id) WHERE p.tenant_id=$1 AND p.production_order_id=$2 ORDER BY p.created_at DESC,p.id DESC`,args)
  const canEdit=ctx.permissions.includes("production.manage")
  return {tenantId:ctx.tenantId,canEdit,canConsume:canEdit&&ctx.permissions.includes("inventory.stock.read")&&ctx.permissions.includes("inventory.stock.manage"),data,
    history:events.rows,consumptions:consumed.rows.map(({quantity_micros,unit_cost_cents,amount_cents,...r})=>({...r,quantity:qty(quantity_micros),unitCost:decimal(BigInt(String(unit_cost_cents)),2),amount:decimal(BigInt(String(amount_cents)),2)})),
    planned:planned.rows.map(({per_unit_micros,total,held,...r})=>({...r,perUnit:qty(per_unit_micros),total:qty(total),reserved:qty(held)})),
    postings:batches.rows.map(({produced_micros,loss_micros,value_micros,additional_cents,...r})=>({...r,produced:qty(produced_micros),loss:qty(loss_micros),value:moneyFromMicros(value_micros==null?null:BigInt(String(value_micros))),additionalCost:decimal(BigInt(String(additional_cents)),2)}))}
}
