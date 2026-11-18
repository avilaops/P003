import {z} from "zod"
import type {AuthorizedContext} from "../../platform/access.js"
import {serialList} from "../inventory/serials.js"
import {conflict} from "./draft-data.js"

export const serialSelection=z.array(z.strictObject({lineNumber:z.number().int().min(1).max(990),serials:serialList})).max(990)
  .refine(lines=>new Set(lines.map(line=>line.lineNumber)).size===lines.length)
export type SerialSelection=z.infer<typeof serialSelection>
export async function lotSerials(c:AuthorizedContext,order:string,lot:string,mode:"deliver"|"return",
  lines:{line:number;product:string;quantity:string}[],selected:SerialSelection=[]){
  if(selected.some(row=>!lines.some(line=>line.line===row.lineNumber)))conflict("Informe séries somente nas linhas da operação")
  const result=new Map<number,string[]>()
  for(const line of lines){
    const input=selected.find(row=>row.lineNumber===line.line)?.serials
    const params=[c.tenantId,line.product,order,lot]
    if(!(await c.client.query("SELECT 1 FROM stock_serial_products WHERE tenant_id=$1 AND product_id=$2",params.slice(0,2))).rows.length){
      if(input?.length)conflict("O produto da linha não usa números de série")
      continue
    }
    const query=mode==="deliver" ? `SELECT s.serial FROM stock_serials s JOIN sales_order_lines l
      ON (l.tenant_id,l.product_id,l.order_id)=(s.tenant_id,s.product_id,s.reserved_order_id)
      WHERE s.tenant_id=$1 AND s.product_id=$2 AND l.order_id=$3 AND s.warehouse_id=l.warehouse_id AND s.status='reserved'`
      : `SELECT serial FROM sales_delivered_lot_serials WHERE tenant_id=$1 AND product_id=$2 AND order_id=$3 AND lot_id=$4`
    const options=(await c.client.query<{serial:string}>(query,mode==="deliver"?params.slice(0,3):params)).rows.map(row=>row.serial)
    const available=new Set(options)
    const serials=input??(mode==="deliver"?options:[])
    if(BigInt(serials.length)*1000000n!==BigInt(line.quantity) || serials.some(unit=>!available.has(unit)))
      conflict(mode==="deliver"?"Identifique uma série reservada por unidade deste lote":"Identifique uma série vendida neste lote por unidade devolvida")
    result.set(line.line,serials)
  }
  return result
}
