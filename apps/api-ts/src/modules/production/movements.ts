import {randomUUID} from "node:crypto"
import {z} from "zod"
import type {AuthorizedContext} from "../../platform/access.js"
import {record} from "../../platform/commands.js"
import {normalizedDatabaseId as id} from "../../platform/database-id.js"
import {fixed} from "../sales/fixed.js"
import {movementValues} from "../inventory/valuation.js"
import {conflict,invalid,missing,stockPermission,type Headers} from "./read.js"

export const reason=z.string().trim().min(3).max(500).refine(v=>!/[\u0000-\u001f\u007f]/.test(v))
export const consumeInput=z.strictObject({productId:id,quantity:z.string(),unitCost:z.string(),reason})
export const postingInput=z.strictObject({produced:z.string(),loss:z.string(),minutes:z.number().int().min(0).max(5256000),additionalCost:z.string(),reason})
type Job={id:string;product_id:string;quantity_micros:string;bom_version:number|null;warehouse_id:string|null;status:string;revision:string;stage_id:string}
export type {Job}
type Movement={id:string;product:string;quantity:bigint;direction:"receipt"|"issue";reason:string;site?:string|null;original?:string;value?:bigint|null}
async function move(ctx:AuthorizedContext,headers:Headers,job:string,m:Movement){
  const {client,tenantId}=ctx
  await client.query("INSERT INTO stock_balances(tenant_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[tenantId,m.product])
  const balance=(await client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE",[tenantId,m.product])).rows[0]!
  const next=BigInt(String(balance.quantity_micros))+(m.direction==="issue"?-m.quantity:m.quantity)
  if(next<0n||next>999999999999999999n)throw conflict("Saldo físico insuficiente ou limite excedido")
  if(m.direction==="issue"){
    const held=(await client.query("SELECT coalesce(sum(quantity_micros),0) held FROM stock_location_reservations WHERE tenant_id=$1 AND product_id=$2",[tenantId,m.product])).rows[0]!.held
    if(next<BigInt(String(held)))throw conflict("Saldo reservado em vendas")
  }
  await client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2",[tenantId,m.product,next])
  await client.query(`INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,production_order_id,warehouse_id,reverses_id,input_value_micros)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[m.id,tenantId,m.product,m.direction,m.quantity,next,m.reason,job,m.site,m.original,m.value])
  await record(ctx,headers,"stock_movement",m.id,"stock.moved",{productionOrderId:job,productId:m.product,direction:m.direction,reason:m.reason,reversesId:m.original??null})
}
export async function consume(ctx:AuthorizedContext,headers:Headers,job:Job,input:z.output<typeof consumeInput>){
  if(job.status!=="open")throw conflict("Reabra a ordem antes de registrar novos consumos")
  const product=input.productId,quantity=fixed(input.quantity,6),unit=fixed(input.unitCost,2)
  if(product===job.product_id||quantity<=0n)throw invalid("Selecione um componente distinto e informe quantidade positiva")
  const {client,tenantId}=ctx
  const p=(await client.query("SELECT sku,name,unit,status FROM products WHERE tenant_id=$1 AND id=$2",[tenantId,product])).rows[0]
  if(!p)throw missing()
  if(p.status!=="active")throw conflict("Reative o componente antes do consumo")
  const planned=(await client.query("SELECT 1 FROM production_structure_items WHERE tenant_id=$1 AND product_id=$2 AND version=$3 AND component_id=$4",[tenantId,job.product_id,job.bom_version,product])).rows.length
  if(planned)throw conflict("Este componente está na estrutura da ordem. Registre o apontamento para consumi-lo")
  const amount=(quantity*unit+500000n)/1000000n,movement=randomUUID()
  if(amount>99999999999999n)throw invalid("Custo total excede o limite permitido")
  await move(ctx,headers,job.id,{id:movement,product,quantity,direction:"issue",reason:input.reason,site:job.warehouse_id})
  await client.query(`INSERT INTO production_consumptions(tenant_id,production_order_id,stock_movement_id,product_id,sku,name,unit,quantity_micros,unit_cost_cents,amount_cents)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[tenantId,job.id,movement,product,p.sku,p.name,p.unit,quantity,unit,amount])
  return [movement]
}
type Active={id:string;product_id:string;direction:"issue"|"receipt";quantity_micros:string}
async function reverse(ctx:AuthorizedContext,headers:Headers,job:string,row:Active,reason:string){
  const id=randomUUID()
  await move(ctx,headers,job,{id,product:row.product_id,quantity:BigInt(row.quantity_micros),direction:row.direction==="issue"?"receipt":"issue",original:row.id,reason})
  return id
}
export async function reverseManual(ctx:AuthorizedContext,headers:Headers,job:string,reason:string,only?:string){
  const {rows}=await ctx.client.query<Active>(`SELECT m.id,m.product_id,m.quantity_micros,m.direction FROM production_consumptions c JOIN stock_movements m
    ON (m.tenant_id,m.id)=(c.tenant_id,c.stock_movement_id) WHERE c.tenant_id=$1 AND c.production_order_id=$2 AND ($3::uuid IS NULL OR m.id=$3)
    AND NOT EXISTS(SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM production_posting_inputs i WHERE i.tenant_id=m.tenant_id AND i.movement_id=m.id
      AND NOT EXISTS(SELECT 1 FROM production_posting_reversals r WHERE (r.tenant_id,r.posting_id)=(i.tenant_id,i.posting_id))) ORDER BY m.product_id,m.id`,[ctx.tenantId,job,only])
  if(only&&!rows.length)throw conflict("Consumo já apropriado, estornado ou ausente nesta ordem")
  if(rows.length)stockPermission(ctx)
  const ids=[]
  for(const row of rows)ids.push(await reverse(ctx,headers,job,row,reason))
  return ids
}
// Called before commercial cancellation and when a finished order is reopened.
export async function reversePostings(ctx:AuthorizedContext,headers:Headers,job:string,reason:string){
  const {client,tenantId}=ctx,ids=[]
  const active=await client.query(`SELECT id FROM production_postings p WHERE p.tenant_id=$1 AND p.production_order_id=$2 AND NOT EXISTS(
    SELECT 1 FROM production_posting_reversals r WHERE (r.tenant_id,r.posting_id)=(p.tenant_id,p.id)) ORDER BY created_at DESC,id DESC`,[tenantId,job])
  if(active.rows.length)stockPermission(ctx)
  for(const p of active.rows){
    const movements=await client.query<Active>(`SELECT m.id,m.product_id,m.quantity_micros,m.direction FROM production_postings p JOIN stock_movements m ON m.tenant_id=p.tenant_id
      AND (m.id=p.receipt_id OR EXISTS(SELECT 1 FROM production_posting_inputs i WHERE (i.tenant_id,i.posting_id,i.movement_id)=(p.tenant_id,p.id,m.id)))
      WHERE p.tenant_id=$1 AND p.id=$2 ORDER BY (m.direction='receipt') DESC,m.product_id,m.id`,[tenantId,p.id])
    for(const row of movements.rows)ids.push(await reverse(ctx,headers,job,row,reason))
    await client.query("INSERT INTO production_posting_reversals(tenant_id,posting_id,reason,actor) VALUES($1,$2,$3,$4)",[tenantId,p.id,reason,ctx.authSubject])
  }
  return ids
}
function prorated(per:bigint,run:bigint){return (per*run+999999n)/1000000n}
export async function postRun(ctx:AuthorizedContext,headers:Headers,job:Job,input:z.output<typeof postingInput>){
  if(job.status!=="open")throw conflict("A ordem precisa estar aberta para receber apontamento")
  const produced=fixed(input.produced,6),loss=fixed(input.loss,6),extra=fixed(input.additionalCost,2)
  const {client,tenantId}=ctx
  const previous=(await client.query(`SELECT coalesce(sum(produced_micros+loss_micros),0) run FROM production_postings p WHERE p.tenant_id=$1 AND p.production_order_id=$2
    AND NOT EXISTS(SELECT 1 FROM production_posting_reversals r WHERE (r.tenant_id,r.posting_id)=(p.tenant_id,p.id))`,[tenantId,job.id])).rows[0]!
  const run=BigInt(String(previous.run)),next=run+produced+loss,total=BigInt(job.quantity_micros)
  if(produced+loss===0n||next>total)throw invalid("O total produzido e perdido deve ser positivo e caber na quantidade restante da ordem")
  const parts=await client.query<{component_id:string;per_unit_micros:string;status:string}>(`SELECT i.component_id,i.per_unit_micros,p.status FROM production_structure_items i
    JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.component_id) WHERE i.tenant_id=$1 AND i.product_id=$2 AND i.version=$3 ORDER BY i.component_id`,[tenantId,job.product_id,job.bom_version])
  const ids:string[]=[],fresh=new Map<string,string>()
  for(const p of parts.rows){
    if(p.status!=="active")throw conflict("Reative os componentes da estrutura para apontar")
    const per=BigInt(p.per_unit_micros),quantity=prorated(per,next)-prorated(per,run)
    if(!quantity)continue
    const id=randomUUID()
    await move(ctx,headers,job.id,{id,product:p.component_id,direction:"issue",quantity,site:job.warehouse_id,reason:input.reason})
    fresh.set(id,p.component_id);ids.push(id)
  }
  const manual=await client.query<{stock_movement_id:string;product_id:string;amount_cents:string}>(`SELECT c.stock_movement_id,c.product_id,c.amount_cents FROM production_consumptions c
    WHERE c.tenant_id=$1 AND c.production_order_id=$2 AND NOT EXISTS(SELECT 1 FROM stock_movements r WHERE r.tenant_id=c.tenant_id AND r.reverses_id=c.stock_movement_id)
    AND NOT EXISTS(SELECT 1 FROM production_posting_inputs i WHERE i.tenant_id=c.tenant_id AND i.movement_id=c.stock_movement_id)`,[tenantId,job.id])
  const costs=await movementValues(ctx,[...new Set([...fresh.values(),...manual.rows.map(c=>c.product_id)])])
  let value:bigint|null=extra*1000000n
  for(const id of fresh.keys()){const cost=costs.get(id)?.amount;value=cost==null||value===null?null:value+cost}
  for(const c of manual.rows){if(value!==null)value+=costs.get(c.stock_movement_id)?.amount??BigInt(c.amount_cents)*1000000n}
  if(!job.bom_version&&!manual.rows.length&&!extra)value=null
  const posting=randomUUID(),receipt=produced>0n?randomUUID():null
  if(receipt){
    await move(ctx,headers,job.id,{id:receipt,product:job.product_id,direction:"receipt",quantity:produced,site:job.warehouse_id,reason:input.reason,value})
    ids.push(receipt)
  }
  await client.query(`INSERT INTO production_postings(tenant_id,id,production_order_id,produced_micros,loss_micros,minutes,additional_cents,value_micros,receipt_id,reason,actor)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[tenantId,posting,job.id,produced,loss,input.minutes,extra,value,receipt,input.reason,ctx.authSubject])
  for(const movement of [...fresh.keys(),...manual.rows.map(c=>c.stock_movement_id)]){
    await client.query("INSERT INTO production_posting_inputs(tenant_id,posting_id,movement_id) VALUES($1,$2,$3)",[tenantId,posting,movement])
  }
  if(next===total)await client.query(`UPDATE production_orders SET status='ready',finished_at=clock_timestamp(),
    stage_id=(SELECT id FROM production_stages WHERE tenant_id=$1 AND kind='pronta') WHERE tenant_id=$1 AND id=$2`,[tenantId,job.id])
  return {ids,details:{postingId:posting,receiptId:receipt,produced:input.produced,loss:input.loss,minutes:input.minutes}}
}
