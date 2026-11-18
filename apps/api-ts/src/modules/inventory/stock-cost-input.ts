import {z} from "zod"
import type {AuthorizedContext} from "../../platform/access.js"
import {normalizedDatabaseId as id} from "../../platform/database-id.js"
import {Problem} from "../../platform/problem.js"
import {decimal,fixed} from "../sales/fixed.js"
import {moneyFromMicros,positionKey,projectedCosts} from "./valuation.js"

const amount=z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/)
const reason=z.string().trim().min(3).max(500)
export const costBasisSchema=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("opening"),productId:id,warehouseId:id,amount,reason}),
  z.strictObject({kind:z.literal("receipt"),productId:id,movementId:id,amount:amount.optional(),freight:amount,recoverableTax:amount,revision:z.number().int().positive().optional(),reason})
])
export const basisQuery=z.strictObject({productId:id,movementId:id})
export async function readReceiptBasis(ctx:AuthorizedContext,input:z.output<typeof basisQuery>){
  const row=(await ctx.client.query(`SELECT i.revision,i.freight_cents,i.recoverable_cents,coalesce(i.base_micros,l.amount_cents::numeric*1000000) AS base,
    m.source_purchase_receipt_id IS NOT NULL OR m.production_order_id IS NOT NULL AS sourced
    FROM stock_cost_inputs i JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
    LEFT JOIN purchase_receipt_lines l ON (l.tenant_id,l.receipt_id,l.product_id)=(m.tenant_id,m.source_purchase_receipt_id,m.product_id)
    WHERE i.tenant_id=$1 AND i.product_id=$2 AND i.movement_id=$3 AND m.direction='receipt' AND m.reverses_id IS NULL AND m.transfer_id IS NULL`,
    [ctx.tenantId,input.productId,input.movementId])).rows[0]
  if(!row)throw new Problem(404,"not_found","Entrada original não encontrada nesta empresa")
  return {tenantId:ctx.tenantId,revision:Number(row.revision),sourced:row.sourced===true,
    amount:moneyFromMicros(row.base==null?null:BigInt(String(row.base))),freight:decimal(BigInt(String(row.freight_cents)),2),
    recoverableTax:decimal(BigInt(String(row.recoverable_cents)),2)}
}
export async function adjustCostBasis(ctx:AuthorizedContext,input:z.output<typeof costBasisSchema>){
  const {client,tenantId}=ctx
  if(input.kind==="opening"){
    await client.query("SELECT check_stock_open_period($1,'1900-01-01')",[tenantId])
    const {positions}=await projectedCosts(ctx,[input.productId])
    const position=positions.get(positionKey(input.productId,input.warehouseId))
    if(!position || position.opening<=0n) throw new Problem(409,"domain_conflict","O produto não tem saldo de abertura anterior aos movimentos nesse depósito")
    await client.query(`INSERT INTO stock_opening_costs(tenant_id,product_id,warehouse_id,amount_micros) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,product_id,warehouse_id) DO UPDATE SET amount_micros=excluded.amount_micros`,[tenantId,input.productId,input.warehouseId,fixed(input.amount,2)*1000000n])
    await client.query("SELECT queue_stock_cost($1,$2,'1900-01-01')",[tenantId,input.productId])
  }else{
    const row=(await client.query<{effective:string;base:string|null;purchased:boolean;revision:string}>(`SELECT i.effective_on::text effective,i.revision,coalesce(i.base_micros,l.amount_cents::numeric*1000000)::text base,
      m.source_purchase_receipt_id IS NOT NULL OR m.production_order_id IS NOT NULL AS purchased FROM stock_cost_inputs i JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
      LEFT JOIN purchase_receipt_lines l ON (l.tenant_id,l.receipt_id,l.product_id)=(m.tenant_id,m.source_purchase_receipt_id,m.product_id)
      WHERE i.tenant_id=$1 AND i.product_id=$2 AND i.movement_id=$3 AND m.direction='receipt' AND m.transfer_id IS NULL AND m.reverses_id IS NULL FOR UPDATE OF i`,
      [tenantId,input.productId,input.movementId])).rows[0]
    if(!row) throw new Problem(404,"not_found","Entrada original não encontrada nesta empresa")
    if(input.revision!==undefined && Number(row.revision)!==input.revision)throw new Problem(412,"revision_conflict","A composição de custo mudou. Atualize a revisão")
    await client.query("SELECT check_stock_open_period($1,$2)",[tenantId,row.effective])
    if(row.purchased && input.amount!==undefined) throw new Problem(422,"invalid_input","O valor de origem vem do documento da entrada")
    const base=input.amount===undefined ? row.base===null ? null : BigInt(row.base) : fixed(input.amount,2)*1000000n
    const freight=fixed(input.freight,2),tax=fixed(input.recoverableTax,2)
    if(base===null || base+(freight-tax)*1000000n<0n) throw new Problem(422,"invalid_input","Confira o valor de entrada, o frete e os impostos recuperáveis")
    await client.query(`UPDATE stock_cost_inputs SET revision=revision+1,base_micros=coalesce($4,base_micros),freight_cents=$5,recoverable_cents=$6
      WHERE tenant_id=$1 AND product_id=$2 AND movement_id=$3`,[tenantId,input.productId,input.movementId,input.amount===undefined ? null : base,freight,tax])
    await client.query("SELECT queue_stock_cost($1,$2,$3)",[tenantId,input.productId,row.effective])
  }
  return {tenantId,id:input.productId,...input}
}
