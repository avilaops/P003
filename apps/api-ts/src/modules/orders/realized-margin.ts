import type {AuthorizedContext} from "../../platform/access.js"
import {moneyFromMicros,projectedCosts,roundedCost} from "../inventory/valuation.js"
import {decimal} from "../sales/fixed.js"

export function canReadRealizedMargin(ctx:AuthorizedContext){
  return ctx.permissions.includes("sales.approvals.director") && ctx.permissions.includes("platform.company.manage")
}

export async function realizedMargin(ctx:AuthorizedContext,id:string,status:unknown){
  if(!["completed","cancelled"].includes(String(status)) || !canReadRealizedMargin(ctx)) return undefined
  const {rows}=await ctx.client.query<{id:string;product_id:string;issued:string;ordered:string;amount_cents:string;reversed:string}>(`
    SELECT m.id,m.product_id,m.quantity_micros::text issued,l.quantity_micros::text ordered,l.amount_cents::text,
      (SELECT coalesce(sum(r.quantity_micros),0)::text FROM stock_movements r
       WHERE (r.tenant_id,r.reverses_id)=(m.tenant_id,m.id) AND r.direction='receipt') reversed
    FROM stock_movements m JOIN sales_order_lines l ON (l.tenant_id,l.order_id,l.product_id)=(m.tenant_id,m.source_order_id,m.product_id)
    WHERE m.tenant_id=$1 AND m.source_order_id=$2 AND m.direction='issue'`,[ctx.tenantId,id])
  if(!rows.length)return undefined
  const {movements,saleReturns}=await projectedCosts(ctx,[...new Set(rows.map(row=>row.product_id))])
  const returned=new Map<string,{commercial:bigint;stock:bigint}>()
  for(const part of saleReturns){
    const total=returned.get(part.issue_id)??{commercial:0n,stock:0n}
    total.commercial+=BigInt(part.returned)
    if(part.receipt_id)total.stock+=BigInt(part.returned)
    returned.set(part.issue_id,total)
  }
  const lines=new Map<string,{retained:bigint;ordered:bigint;cents:bigint}>()
  let cost:bigint|null=0n,revenue=0n
  for(const row of rows){
    const issued=BigInt(row.issued),reversed=BigInt(row.reversed),partial=returned.get(row.id)
    const line=lines.get(row.product_id)??{retained:0n,ordered:BigInt(row.ordered),cents:BigInt(row.amount_cents)}
    line.retained+=issued-reversed-(partial?.commercial??0n)
    lines.set(row.product_id,line)
    const restocked=reversed+(partial?.stock??0n)
    if(restocked===issued)continue
    const amount=movements.get(row.id)?.amount
    cost=amount==null||cost===null?null:cost+amount-roundedCost(amount*restocked,issued)
  }
  for(const line of lines.values())revenue+=roundedCost(line.cents*line.retained,line.ordered)*1000000n
  const profit=cost===null?null:revenue-cost
  const rate=profit===null||revenue===0n?null:roundedCost(profit*10000n,revenue)
  return {revenue:moneyFromMicros(revenue),cost:moneyFromMicros(cost),grossProfit:moneyFromMicros(profit),
    marginPercent:rate===null?null:rate<0n?"-"+decimal(-rate,2):decimal(rate,2)}
}
