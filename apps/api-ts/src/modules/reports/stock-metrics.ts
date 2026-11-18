import type { AuthorizedContext } from "../../platform/access.js"
import { movementOriginJoins } from "../inventory/queries.js"
import { moneyFromMicros, projectedCosts, roundedCost, unitFromMicros, unitValue } from "../inventory/valuation.js"
import { decimal } from "../sales/fixed.js"
import type { StockDataset } from "./stock-catalog.js"

export type ReportRow=Record<string,string|number|null>
type Filters={start:string;end:string;productId?:string|undefined;warehouseId?:string|undefined;idleDays:number}
export type Product={id:string;sku:string;name:string;unit:string}
export function daysBetween(a:string,b:string){return (Date.parse(b)-Date.parse(a))/86_400_000}
export function dayBefore(date:string,days=1){return new Date(Date.parse(date)-days*86_400_000).toISOString().slice(0,10)}
function qty(n:bigint){return n<0n?"-"+decimal(-n,6):decimal(n,6)}
function ratio(n:bigint,d:bigint,scale:number){return d>0n?decimal(roundedCost(n*10n**BigInt(scale),d),scale):null}
const description=(p:Product)=>({sku:p.sku,product:p.name,unit:p.unit})

async function countRows(ctx:AuthorizedContext,dataset:StockDataset,f:Filters):Promise<ReportRow[]> {
  const from=`FROM inventory_counts c JOIN inventory_count_lines l ON (l.tenant_id,l.count_id)=(c.tenant_id,c.id)
    JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id)
    LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(c.tenant_id,c.warehouse_id)
    WHERE c.tenant_id=$1 AND c.status='approved' AND l.counted_quantity_micros IS NOT NULL
    AND (c.approved_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3
    AND ($4::uuid IS NULL OR p.id=$4) AND ($5::uuid IS NULL OR c.warehouse_id=$5)`
  const args=[ctx.tenantId,f.start,f.end,f.productId,f.warehouseId]
  if(dataset==="stock_accuracy"){
    const {rows:[r]}=await ctx.client.query<{lines:string;matched:string}>(`SELECT count(*) lines,
      count(*) FILTER(WHERE l.expected_quantity_micros=l.counted_quantity_micros) matched `+from,args)
    const lines=BigInt(r!.lines),matched=BigInt(r!.matched)
    return [{lines:Number(lines),matched:Number(matched),accuracy:ratio(matched*100n,lines,2)}]
  }
  const {rows}=await ctx.client.query<{sku:string;product:string;unit:string;date:string;reference:string;warehouse:string;expected:string;counted:string}>(`
    SELECT p.sku,p.name product,p.unit,(c.approved_at AT TIME ZONE 'America/Sao_Paulo')::date::text date,c.reference,
    coalesce(w.name,'Consolidado') warehouse,l.expected_quantity_micros::text expected,l.counted_quantity_micros::text counted `+from+
    " AND l.expected_quantity_micros<>l.counted_quantity_micros ORDER BY c.approved_at,c.id,p.sku,p.id",args)
  return rows.map(r=>({...r,expected:qty(BigInt(r.expected)),counted:qty(BigInt(r.counted)),difference:qty(BigInt(r.counted)-BigInt(r.expected))}))
}

async function kardex(ctx:AuthorizedContext,p:Product,f:Filters):Promise<ReportRow[]> {
  const {positions,movements}=await projectedCosts(ctx,[p.id],f.end)
  const {rows}=await ctx.client.query<{id:string;kind:string;document:string;reason:string;direction:string;warehouse:string;quantity:string}>(`
    SELECT m.id,CASE WHEN m.reverses_id IS NOT NULL THEN 'Estorno' WHEN m.transfer_id IS NOT NULL THEN 'Transferência'
      WHEN m.inventory_count_id IS NOT NULL OR origin.inventory_count_id IS NOT NULL THEN 'Inventário'
      WHEN m.production_order_id IS NOT NULL THEN 'Produção' WHEN m.source_order_id IS NOT NULL THEN 'Venda'
      WHEN m.source_purchase_receipt_id IS NOT NULL THEN 'Compras' WHEN m.source_pos_sale_id IS NOT NULL THEN 'PDV'
      WHEN w.case_id IS NOT NULL THEN 'Garantia' WHEN origin.return_source_id IS NOT NULL THEN 'Devolução'
      ELSE 'Manual' END kind,
      coalesce(m.reverses_id::text,m.transfer_id::text,m.inventory_count_id::text,origin.inventory_count_id,m.production_order_id::text,
        m.source_order_id::text,m.source_purchase_receipt_id::text,m.source_pos_sale_id::text,w.case_id::text,origin.return_source_id,m.id::text) document,
      m.reason,m.direction,coalesce(loc.name,'Abertura') warehouse,m.quantity_micros::text quantity
    FROM stock_movements m JOIN stock_cost_inputs i ON (i.tenant_id,i.movement_id)=(m.tenant_id,m.id)
    JOIN stock_location_settings s ON s.tenant_id=m.tenant_id
    LEFT JOIN warehouses loc ON (loc.tenant_id,loc.id)=(m.tenant_id,coalesce(m.warehouse_id,s.opening_id))
    ${movementOriginJoins} WHERE m.tenant_id=$1 AND m.product_id=$2 AND i.effective_on BETWEEN $3 AND $4
      AND ($5::uuid IS NULL OR coalesce(m.warehouse_id,s.opening_id)=$5) ORDER BY i.effective_on,m.created_at,m.id`,
    [ctx.tenantId,p.id,f.start,f.end,f.warehouseId])
  if(!rows.length){
    const closing=[...positions.values()].filter(v=>!f.warehouseId||v.warehouseId===f.warehouseId).reduce((a,b)=>a+b.quantity,0n)
    return [{...description(p),date:f.end,kind:"Saldo sem movimentos",document:null,reason:null,warehouse:null,
      opening:qty(closing),receipts:qty(0n),issues:qty(0n),closing:qty(closing),cost:null,value:null}]
  }
  return rows.map(r=>{
    const valued=movements.get(r.id)!,n=BigInt(r.quantity),receipt=r.direction==="receipt"
    const after=f.warehouseId?valued.quantityAfter:valued.totalAfter
    return {...description(p),date:valued.date,warehouse:r.warehouse,kind:r.kind,document:r.document,reason:r.reason,
      opening:qty(after+(receipt?-n:n)),receipts:qty(receipt?n:0n),issues:qty(receipt?0n:n),closing:qty(after),
      value:moneyFromMicros(valued.amount),cost:unitFromMicros(valued.unit)}
  })
}

async function demand(ctx:AuthorizedContext,f:Filters) {
  // The reversal reduces demand on its effective date. For inactivity the original issue ceases to count once its reversal is effective.
  const {rows}=await ctx.client.query<{product_id:string;consumed:string;last_issue:string|null}>(`
    WITH issues AS (
      SELECT m.product_id,m.quantity_micros,i.effective_on issued,rev.effective_on reversed FROM stock_movements m
      JOIN stock_cost_inputs i ON (i.tenant_id,i.movement_id)=(m.tenant_id,m.id)
      JOIN stock_location_settings s ON s.tenant_id=m.tenant_id
      LEFT JOIN LATERAL (SELECT ri.effective_on FROM stock_movements r JOIN stock_cost_inputs ri ON
        (ri.tenant_id,ri.movement_id)=(r.tenant_id,r.id) WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) rev ON true
      ${movementOriginJoins}
      WHERE m.tenant_id=$1 AND m.direction='issue' AND m.transfer_id IS NULL AND m.reverses_id IS NULL
        AND m.inventory_count_id IS NULL AND origin.inventory_count_id IS NULL AND w.case_id IS NULL AND origin.return_source_id IS NULL
        AND i.effective_on<=$3 AND ($4::uuid IS NULL OR m.product_id=$4) AND ($5::uuid IS NULL OR coalesce(m.warehouse_id,s.opening_id)=$5)
    ) SELECT product_id,(coalesce(sum(quantity_micros) FILTER(WHERE issued BETWEEN $2 AND $3),0)
      - coalesce(sum(quantity_micros) FILTER(WHERE reversed BETWEEN $2 AND $3),0))::text consumed,
      max(issued) FILTER(WHERE reversed IS NULL OR reversed>$3)::text last_issue FROM issues GROUP BY product_id`,
    [ctx.tenantId,f.start,f.end,f.productId,f.warehouseId])
  return new Map(rows.map(r=>[r.product_id,r]))
}
async function reservations(ctx:AuthorizedContext,f:Filters){
  const {rows}=await ctx.client.query<{product_id:string;reserved:string}>(`SELECT product_id,sum(quantity_micros)::text reserved FROM (
    SELECT product_id,quantity_micros FROM stock_location_reservations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR warehouse_id=$2) AND ($3::uuid IS NULL OR product_id=$3)
    UNION ALL SELECT product_id,quantity_micros FROM production_component_reservations WHERE tenant_id=$1 AND ($2::uuid IS NULL OR warehouse_id=$2) AND ($3::uuid IS NULL OR product_id=$3)
    ) reserved GROUP BY product_id`,[ctx.tenantId,f.warehouseId,f.productId])
  return new Map(rows.map(r=>[r.product_id,BigInt(r.reserved)]))
}

export async function stockMetrics(ctx:AuthorizedContext,dataset:StockDataset,products:Product[],f:Filters):Promise<ReportRow[]> {
  if(dataset==="stock_divergences" || dataset==="stock_accuracy")return countRows(ctx,dataset,f)
  if(dataset==="stock_kardex")return products.length?kardex(ctx,products[0]!,f):[]
  const ids=products.map(p=>p.id)
  async function values(until?:string){
    const {positions}=await projectedCosts(ctx,ids,until)
    const perProduct=new Map<string,{quantity:bigint;value:bigint|null}>()
    for(const v of positions.values()){
      if(f.warehouseId && v.warehouseId!==f.warehouseId)continue
      const old=perProduct.get(v.productId)??{quantity:0n,value:0n}
      old.quantity+=v.quantity
      old.value=old.value===null||v.value===null?null:old.value+v.value
      perProduct.set(v.productId,old)
    }
    return perProduct
  }
  const closing=await values(dataset==="stock_position"?undefined:f.end)
  const opened=dataset==="stock_turnover"?await values(dayBefore(f.start)):null
  const demandById=dataset==="stock_turnover"||dataset==="stock_idle"?await demand(ctx,f):null
  const reservedById=dataset==="stock_position"?await reservations(ctx,f):null
  const order=[...products]
  if(dataset==="stock_abc")order.sort((a,b)=>{
    const left=closing.get(a.id)?.value,right=closing.get(b.id)?.value
    const x=left===null?-1n:left??0n,y=right===null?-1n:right??0n
    return x>y?-1:x<y?1:0
  })
  const totalValue=[...closing.values()].reduce((sum,r)=>sum+(r.value??0n),0n)
  let accumulated=0n
  const rows:ReportRow[]=[]
  for(const p of order){
    const pos=closing.get(p.id)??{value:0n,quantity:0n},base=description(p),quantity=qty(pos.quantity)
    const value=moneyFromMicros(pos.value)
    if(dataset==="stock_position"){
      const reserved=reservedById!.get(p.id)??0n
      rows.push({...base,quantity,reserved:qty(reserved),available:qty(pos.quantity-reserved),cost:unitFromMicros(unitValue(pos)),value})
    }else if(dataset==="stock_abc"){
      const known=pos.value!==null && totalValue>0n
      const group=known?(accumulated*100n<totalValue*80n?"A":accumulated*100n<totalValue*95n?"B":"C"):null
      accumulated+=pos.value??0n
      rows.push({...base,quantity,value,share:known?ratio(100n*pos.value!,totalValue,2):null,cumulative:known?ratio(100n*accumulated,totalValue,2):null,class:group})
    }else if(dataset==="stock_idle"){
      const last=demandById!.get(p.id)?.last_issue??null,days=last?daysBetween(last,f.end):null
      if(pos.quantity>0n && (days===null||days>=f.idleDays))rows.push({...base,quantity,last_issue:last,idle_days:days,history:last?"Saída registrada":"Sem saída registrada"})
    }else{
      const n=BigInt(demandById!.get(p.id)?.consumed??0),opening=opened!.get(p.id)?.quantity??0n,sum=opening+pos.quantity
      rows.push({...base,opening:qty(opening),closing:quantity,demand:qty(n),average:qty(roundedCost(sum,2n)),
        turnover:n<0n?null:ratio(2n*n,sum,4),coverage:ratio(pos.quantity*BigInt(daysBetween(f.start,f.end)+1),n,2)})
    }
  }
  return rows
}

