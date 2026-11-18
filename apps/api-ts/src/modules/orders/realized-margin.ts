import type {AuthorizedContext} from "../../platform/access.js"
import {moneyFromMicros,movementValues,roundedCost} from "../inventory/valuation.js"
import {decimal} from "../sales/fixed.js"

export async function realizedMargin(ctx:AuthorizedContext,id:string,status:unknown){
  if(!["completed","cancelled"].includes(String(status))||!ctx.permissions.includes("sales.approvals.director")||!ctx.permissions.includes("platform.company.manage")) return undefined
  const {rows}=await ctx.client.query<{id:string;product_id:string;revenue:string;returned:boolean}>(`
    SELECT m.id,m.product_id,round(l.amount_cents::numeric*m.quantity_micros/l.quantity_micros)::text revenue,
      EXISTS(SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id AND r.direction='receipt') AS returned
    FROM stock_movements m JOIN sales_order_lines l ON (l.tenant_id,l.order_id,l.product_id)=(m.tenant_id,m.source_order_id,m.product_id)
      WHERE m.tenant_id=$1 AND m.source_order_id=$2 AND m.direction='issue'`,[ctx.tenantId,id])
  if(!rows.length)return undefined
  const open=rows.filter(row=>!row.returned)
  const valued=await movementValues(ctx,[...new Set(open.map(row=>row.product_id))])
  let cost:bigint|null=0n,revenue=0n
  for(const row of open){
    revenue+=BigInt(row.revenue)*1000000n
    const amount=valued.get(row.id)?.amount
    cost=amount==null||cost===null?null:cost+amount
  }
  const profit=cost===null?null:revenue-cost
  const rate=profit===null||revenue===0n?null:roundedCost(profit*10000n,revenue)
  return {revenue:moneyFromMicros(revenue),cost:moneyFromMicros(cost),grossProfit:moneyFromMicros(profit),
    marginPercent:rate===null?null:rate<0n?"-"+decimal(-rate,2):decimal(rate,2)}
}
