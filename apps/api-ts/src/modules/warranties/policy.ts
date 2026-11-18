import {z} from "zod"
import type {AuthorizedContext} from "../../platform/access.js"
import {idParam,invalid,limitedText} from "./shared.js"

export const scopeSchema=z.strictObject({
 productId:idParam.optional(),categoryId:idParam.optional(),brand:limitedText(1,80).optional(),
 supplierId:idParam.optional(),channel:limitedText(1,80).optional()
})
export const policySchema=z.strictObject({name:limitedText(3,120),durationDays:z.number().int().min(1).max(3650),
 coverageType:z.enum(["legal","contractual","extended"]),scope:scopeSchema.default({}),validFrom:z.iso.date().optional(),validUntil:z.iso.date().optional()})
 .refine(p=>!p.validFrom||!p.validUntil||p.validUntil>=p.validFrom)
export const traceInput=z.strictObject({receiptId:idParam.optional(),brand:limitedText(1,80).optional(),channel:limitedText(1,80).optional(),
 reference:limitedText(3,200).optional()})
type Trace=z.infer<typeof traceInput>
type Policy={id:string;name:string;coverageType:string;durationDays:number;scope:Record<string,unknown>;status:string;revision:string;validFrom:string|null;validUntil:string|null}
export async function policies(c:AuthorizedContext){
 return (await c.client.query<Policy>(`SELECT id,name,coverage_type AS "coverageType",duration_days AS "durationDays",scope,status,revision::text,
 valid_from::text AS "validFrom",valid_until::text AS "validUntil",updated_at AS "updatedAt" FROM warranty_policies WHERE tenant_id=$1 ORDER BY name,id`,[c.tenantId])).rows
}
export async function validateScope(c:AuthorizedContext,scope:z.infer<typeof scopeSchema>) {
 const row=(await c.client.query(`SELECT
 ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM products WHERE tenant_id=$1 AND id=$2 AND ($3::uuid IS NULL OR category_id=$3))) AND
 ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM product_categories WHERE tenant_id=$1 AND id=$3)) AND
 ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$4 AND is_supplier)) AS valid`,[c.tenantId,scope.productId,scope.categoryId,scope.supplierId])).rows[0]
 if(!row?.valid)invalid("Confira o produto, a categoria e o fornecedor da empresa")
}
export type Origin= {orderId:string;documentId:string;productId:string;lineNumber:number;soldOn:string;categoryId:string|null;channel:string|null;availableUnits:number} & Record<string,unknown>
export async function receiptOptions(c:AuthorizedContext,line:Origin){
 return (await c.client.query<{id:string;supplierId:string;name:string;reference:string}>(`SELECT r.id,o.supplier_id AS "supplierId",o.supplier_name AS name,r.reference
 FROM purchase_receipts r JOIN purchase_receipt_lines i ON (i.tenant_id,i.receipt_id)=(r.tenant_id,r.id) JOIN purchase_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
 WHERE r.tenant_id=$1 AND i.product_id=$2 AND r.occurred_on<=$3 AND i.quantity_micros>0 ORDER BY r.occurred_on DESC,r.id`,[c.tenantId,line.productId,line.soldOn])).rows
}
export function identification(line:Origin,trace:Trace,receipts:Awaited<ReturnType<typeof receiptOptions>>) {
 const receipt=receipts.find(r=>r.id===trace.receiptId)
 if(trace.receiptId&&!receipt)return invalid("O recebimento deve conter o produto até a data da venda")
 if(trace.channel&&line.channel&&trace.channel!==line.channel)return invalid("O canal informado diverge do canal de origem do pedido")
 if((trace.brand||trace.channel&&!line.channel)&&!trace.reference)return invalid("Informe a procedência da marca ou do canal declarado")
 return {productId:line.productId,categoryId:line.categoryId,channel:line.channel??trace.channel??null,brand:trace.brand??null,supplierId:receipt?.supplierId??null,
  receipt:receipt??null,reference:trace.reference??null,channelSource:line.channel?"pedido":trace.channel?"declaração":null,
  categorySource:line.categoryId?"cadastro do produto":null,brandSource:trace.brand?"declaração":null}
}
const normalized=(s:unknown)=>typeof s==="string"?s.normalize("NFC").trim().toLowerCase():s
export function eligiblePolicies(records:Policy[],origin:ReturnType<typeof identification>,soldOn:string){
 const matches=records.filter(p=>p.status==="active"&&(!p.validFrom||p.validFrom<=soldOn)&&(!p.validUntil||p.validUntil>=soldOn)&&
  Object.entries(p.scope).every(([key,value])=>["productId","categoryId","brand","supplierId","channel"].includes(key)&&normalized(value)===normalized(origin[key as keyof typeof origin])))
 return matches.filter(p=>!matches.some(n=>n.coverageType===p.coverageType&&Object.keys(n.scope).length>Object.keys(p.scope).length))
}
