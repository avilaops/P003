import type { TenantContext } from "../../platform/database.js"
import { decimal } from "../sales/fixed.js"

export type CostContext = Pick<TenantContext,"client" | "tenantId">
export type Position = {productId:string; warehouseId:string; quantity:bigint; value:bigint|null; opening:bigint}
export type ValuedMovement = {id:string; productId:string; warehouseId:string; date:string; amount:bigint|null; unit:bigint|null; quantityAfter:bigint; valueAfter:bigint|null; totalAfter:bigint}
type LedgerRow = {id:string|null; product_id:string; warehouse_id:string; effective_on:string|null; quantity:string;
  base:string|null; delta:string; direction:string|null; reverses_id:string|null; transfer_id:string|null}
export function roundedCost(amount:bigint, divisor:bigint):bigint {
  if(amount < 0n) return -roundedCost(-amount,divisor)
  return (amount + divisor / 2n) / divisor
}
export function moneyFromMicros(value:bigint|null):string|null {
  if(value===null) return null
  const cents=roundedCost(value,1000000n)
  return (cents<0n ? "-" : "")+decimal(cents<0n ? -cents : cents,2)
}
export function unitFromMicros(value:bigint|null) {return value===null ? null : decimal(roundedCost(value,100n),6)}
export function unitValue(position:{quantity:bigint;value:bigint|null}) {
  return position.value===null || position.quantity<=0n ? null : roundedCost(position.value*1000000n,position.quantity)
}
export const positionKey = (product:string,warehouse:string)=>product+"/"+warehouse

// Include the pre-ledger opening only once. Receipts from a fiscal XML use the
// landed amount already apportioned on its purchase line; the receipt records
// the actual (possibly partial) amount. Never count freight twice.
export async function projectedCosts({client,tenantId}:CostContext, productIds:readonly string[], until?:string) {
  const positions=new Map<string,Position>(), movements=new Map<string,ValuedMovement>(), transferCosts=new Map<string,bigint|null>()
  const totals=new Map<string,bigint>()
  if(!productIds.length) return {positions,movements}
  const rows=await client.query<LedgerRow>(`
    WITH events AS MATERIALIZED (
      SELECT m.id,m.product_id,coalesce(m.warehouse_id,s.opening_id) warehouse_id,i.effective_on,m.created_at,m.quantity_micros quantity,
          coalesce(i.base_micros,l.amount_cents::numeric*1000000) base,
          (i.freight_cents::numeric-i.recoverable_cents)*1000000 delta,m.direction,m.reverses_id,m.transfer_id
      FROM stock_cost_inputs i JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
      JOIN stock_location_settings s ON s.tenant_id=m.tenant_id
      LEFT JOIN purchase_receipt_lines l ON (l.tenant_id,l.receipt_id,l.product_id)=(m.tenant_id,m.source_purchase_receipt_id,m.product_id)
      WHERE i.tenant_id=$1 AND i.product_id=ANY($2::uuid[])
    ), physical AS (
      SELECT product_id,warehouse_id,quantity_micros::numeric quantity FROM stock_positions WHERE tenant_id=$1 AND product_id=ANY($2::uuid[])
    ), changes AS (
      SELECT product_id,warehouse_id,sum(CASE direction WHEN 'receipt' THEN quantity ELSE -quantity END) delta FROM events GROUP BY product_id,warehouse_id
    ), opening AS (
      SELECT product_id,warehouse_id,coalesce(p.quantity,0)-coalesce(c.delta,0) quantity FROM physical p FULL JOIN changes c USING(product_id,warehouse_id)
    )
    SELECT id,product_id,warehouse_id,effective_on::text,quantity::text,base::text,delta::text,direction,reverses_id,transfer_id FROM (
        SELECT NULL::uuid AS id,o.product_id,o.warehouse_id,NULL::date effective_on,NULL::timestamptz created_at,o.quantity,b.amount_micros AS base,0 AS delta,
          NULL::text direction,NULL::uuid reverses_id,NULL::uuid transfer_id FROM opening o LEFT JOIN stock_opening_costs b ON b.tenant_id=$1 AND b.product_id=o.product_id AND b.warehouse_id=o.warehouse_id
        UNION ALL SELECT id,product_id,warehouse_id,effective_on,created_at,quantity,base,delta,direction,reverses_id,transfer_id FROM events
          WHERE $3::date IS NULL OR effective_on <= $3
    ) ledger ORDER BY ledger.effective_on NULLS FIRST,created_at,id`,[tenantId,productIds,until])
  for(const row of rows.rows) {
    const key=positionKey(row.product_id,row.warehouse_id), qty=BigInt(row.quantity)
    const position=positions.get(key) ?? {productId:row.product_id,warehouseId:row.warehouse_id,quantity:0n,value:0n,opening:0n}
    positions.set(key,position)
    if(!row.id) {
      position.opening=qty
      position.quantity=qty
      position.value=qty===0n ? 0n : row.base===null ? null : BigInt(row.base)
      totals.set(row.product_id,(totals.get(row.product_id)??0n)+qty)
      continue
    }
    const receiving=row.direction==="receipt", transfer=row.transfer_id ? positionKey(row.product_id,row.transfer_id) : null
    let amount:bigint|null
    if(row.reverses_id) amount=movements.get(row.reverses_id)?.amount ?? null
    else if(receiving && transfer) amount=transferCosts.get(transfer) ?? null
    else if(receiving) amount=row.base===null ? null : BigInt(row.base)+BigInt(row.delta)
    else amount=position.value===null || position.quantity<qty ? null : roundedCost(qty*position.value,position.quantity)
    if(transfer && !receiving) transferCosts.set(transfer,amount)
    const change=receiving ? qty : -qty
    position.quantity+=change
    const netPosition=position.value===null || amount===null ? null : position.value+(receiving ? amount : -amount)
    position.value=position.quantity===0n ? 0n : netPosition===null || netPosition<0n || position.quantity<0n ? null : netPosition
    const total=(totals.get(row.product_id)??0n)+change
    totals.set(row.product_id,total)
    movements.set(row.id,{id:row.id,productId:row.product_id,warehouseId:row.warehouse_id,date:row.effective_on!,amount,
      unit:amount===null ? null : roundedCost(amount*1000000n,qty),quantityAfter:position.quantity,valueAfter:position.value,totalAfter:total})
  }
  return {positions,movements}
}
export async function movementValues(context:CostContext,productIds:readonly string[],until?:string) {
  return (await projectedCosts(context,productIds,until)).movements
}
export function productValue(positions:Iterable<Position>,product:string,warehouse?:string) {
  let value:bigint|null=0n, quantity=0n
  for(const row of positions) {
    if(row.productId!==product || warehouse && row.warehouseId!==warehouse) continue
    quantity+=row.quantity
    value=value===null || row.value===null ? null : value+row.value
  }
  return {value, quantity,unit:unitValue({quantity,value})}
}
