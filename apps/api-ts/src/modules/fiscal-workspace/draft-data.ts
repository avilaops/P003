import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { decimal } from "../sales/fixed.js"
import { revisionValue } from "../../platform/revision.js"
import type { DraftInput } from "./draft-schema.js"

export type ObjectData=Record<string,unknown>
export const invalid=(message:string):never=>{throw new Problem(422,"invalid_input",message)}
export const conflict=(message:string):never=>{throw new Problem(409,"domain_conflict",message)}
export function guid(value:unknown) {const r=z.guid().safeParse(value);return r.success ? r.data : invalid("Identificador fiscal inválido")}
export function decimalValue(value:string,scale:number) {
  if (!new RegExp("^\\d{1,13}\\.\\d{"+scale+"}$").test(value)) invalid("Valor decimal fora da precisão fiscal")
  return BigInt(value.replace(".",""))
}
/** NF-e accepts dest/email up to 60 characters and dest/fone with 6 to 14 digits; anything else is left for the user. */
function recipientEmail(value:unknown){const email=typeof value==="string" ? value.trim() : "";return email.length<=60 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null}
function recipientPhone(value:unknown){const digits=typeof value==="string" ? value.replace(/\D/g,"") : "";return /^\d{6,14}$/.test(digits) ? digits : null}
/** Payment modality of the order → tPag of the NF-e. "other" (cheque, financing, on delivery) is declared as 99 with the method name. */
const paymentCodes:Record<string,string>={cash:"01",credit_card:"03",debit_card:"04",boleto:"15",pix:"17",bank_transfer:"18"}
/**
 * Confirmed orders already carry dated installments: the entry receives the confirmation date when it had none.
 * They become the NF-e duplicates (cobr) and the declared payments, grouped by tPag. The user still reviews both.
 */
async function orderPayments(c:AuthorizedContext,id:string){
  const rows=(await c.client.query<{due_on:string|null;amount_cents:string;modality:string|null;name:string|null}>(`SELECT i.due_on::text,i.amount_cents,i.payment_method->>'modality' AS modality,i.payment_method->>'name' AS name
    FROM sales_order_installments i WHERE i.tenant_id=$1 AND i.order_id=$2 ORDER BY i.number`,[c.tenantId,id])).rows
  if(!rows.length || rows.some(r=>!r.due_on)) return {}
  const grouped=new Map<string,{code:string;amount:bigint;description:string|null}>()
  for(const r of rows){
    const code=paymentCodes[r.modality ?? ""] ?? "99",description=code==="99" ? (r.name?.trim().slice(0,60) || "Outros") : null,key=code+"|"+(description ?? "")
    const current=grouped.get(key) ?? {code,amount:0n,description}
    current.amount+=BigInt(r.amount_cents);grouped.set(key,current)
  }
  return {
    installments:rows.map((r,index)=>({number:String(index+1).padStart(3,"0"),dueDate:r.due_on!,amount:decimal(BigInt(r.amount_cents),2)})),
    payments:[...grouped.values()].map(p=>({code:p.code,amount:decimal(p.amount,2),...(p.description ? {description:p.description} : {})})),
  }
}
export async function sourcePreparation(c:AuthorizedContext,id:string) {
  for(const perm of ["sales.orders.read","catalog.parties.read","catalog.products.read","fiscal.nfe.manage"]) requirePermission(c,perm)
  const o=(await c.client.query(`SELECT o.customer_id,o.customer_name,o.customer_tax_id,o.status,o.revision,p.tax_id,p.addresses,p.email,p.phone FROM sales_orders o
    LEFT JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id AND p.is_customer AND p.status='active'
    WHERE o.tenant_id=$1 AND o.id=$2`,[c.tenantId,id])).rows[0]
  if (!o) throw new Problem(404,"not_found","Pedido não encontrado")
  if (!["confirmed","completed"].includes(String(o.status)) || o.customer_tax_id!==o.tax_id) conflict("Confira a reserva e o cadastro atual do cliente do pedido")
  const addresses=Array.isArray(o.addresses) ? o.addresses as ObjectData[] : []
  const address=addresses.find(a=>a.primary===true) ?? (addresses.length===1 ? addresses[0] : undefined)
  const recipient={taxId:String(o.customer_tax_id),legalName:o.customer_name,state:address?.state ?? "",municipalityCode:address?.municipalityCode ?? "",postalCode:address?.postalCode ?? "",
    street:address?.street ?? "",number:address?.number ?? "",district:address?.district ?? "",complement:address?.complement ?? null,cityName:address?.city ?? null,
    email:recipientEmail(o.email),phone:recipientPhone(o.phone)}
  const result=await c.client.query(`SELECT s.product_id,s.sku,s.name,s.unit,p.ncm,s.quantity_micros,order_line_fiscal_price(s) AS price,
    nullif(concat_ws('; ',CASE WHEN s.structure_color<>'' THEN 'Estrutura: '||s.structure_color END,
      CASE WHEN s.swing_arm_color<>'' THEN 'Braços: '||s.swing_arm_color END,
      CASE WHEN s.plate_holder_type<>'' THEN 'Tipo de anilheiro: '||s.plate_holder_type END,
      CASE WHEN s.upholstery_color<>'' THEN 'Estofado: '||s.upholstery_color END),'') AS info
    FROM sales_order_lines s JOIN products p ON p.id=s.product_id AND p.tenant_id=s.tenant_id
    LEFT JOIN product_costs pc ON pc.tenant_id=s.tenant_id AND pc.product_id=s.product_id
    WHERE s.tenant_id=$1 AND s.order_id=$2 ORDER BY s.line_number`,[c.tenantId,id])
  let cents=0n
  const items=result.rows.map(r=>{
    const qty=BigInt(String(r.quantity_micros))
    if (qty%100n || r.price==null || String(r.sku).length>60) conflict("Confira a precisão, o SKU e o preço fiscal das linhas da venda")
    const price=BigInt(String(r.price)),gross=(qty*price+500000n)/1000000n
    cents+=gross
    return {productId:r.product_id,code:r.sku,description:r.name,unit:r.unit,ncm:r.ncm,quantity:decimal(qty/100n,4),unitPrice:decimal(price,2),grossTotal:decimal(gross,2),additionalInfo:r.info}
  })
  // NF-e origin follows the product's registered commercial line (1 direct import, 0 national); unregistered stays for manual choice.
  items.forEach((item,index)=>{ const line=result.rows[index]!.product_line; Object.assign(item,{origin:line==="imported" ? 1 : line==="national" ? 0 : null}) })
  if(!items.length) conflict("O pedido precisa de itens para preparação fiscal")
  return {tenantId:c.tenantId,customerId:o.customer_id,orderId:id,orderRevision:revisionValue(o.revision),recipient,items,productsTotal:decimal(cents,2),...await orderPayments(c,id)}
}
export async function checkOrderSource(c:AuthorizedContext,draft:DraftInput) {
  if (!draft.sourceOrderId) return
  const order=await sourcePreparation(c,draft.sourceOrderId)
  if (draft.model!==55 || (draft.purpose ?? 1)!==1 || draft.recipient.taxId!==order.recipient.taxId || draft.items.length!==order.items.length) conflict("Origem comercial incompatível com o documento")
  for(const [index,item] of draft.items.entries()){
    const line=order.items[index]!
    if (item.code!==line.code || item.unit!==line.unit || decimalValue(item.quantity,4)!==decimalValue(line.quantity,4) ||
        decimalValue(item.unitPrice,10)!==decimalValue(line.unitPrice,2)*100000000n) conflict("Os itens fiscais divergem do pedido de origem")
  }
}
export async function issuerData(c:AuthorizedContext) {
  const row=(await c.client.query<{tax_id:string; legal_name:string; company_revision:string; company:ObjectData; profile_revision:string; profile:ObjectData}>(`
    SELECT t.tax_id,t.legal_name,p.revision AS company_revision,p.details AS company,f.revision AS profile_revision,f.details AS profile
    FROM tenants t JOIN fiscal_profiles f ON f.tenant_id=t.id LEFT JOIN company_profiles p ON p.tenant_id=t.id WHERE t.id=$1`,[c.tenantId])).rows[0]
  if (!row) return undefined
  const company={...row.company,taxId:row.tax_id,legalName:row.legal_name} as ObjectData
  const profile=row.profile
  const valid=!!row.company_revision && company.personType==="juridica" && /^\d{14}$/.test(row.tax_id) && company.state===profile.state && company.stateRegistration===profile.stateRegistration &&
    (company.taxRegime==="simples" ? [1,2,4].includes(Number(profile.crt)) : ["presumido","real"].includes(String(company.taxRegime)) && profile.crt===3)
  return {valid,taxId:row.tax_id,legalName:row.legal_name,companyRevision:row.company_revision ? revisionValue(row.company_revision):0,company,profileRevision:revisionValue(row.profile_revision),profile}
}
export async function loadDraft(c:AuthorizedContext,id:string){
  const row=(await c.client.query<{id:string;revision:string;model:number;environment:string;issuer_snapshot:ObjectData;details:DraftInput;ibpt_snapshot:ObjectData|null;products_total_cents:string}>(`
    SELECT id,revision,model,environment,issuer_snapshot,details,ibpt_snapshot,products_total_cents FROM fiscal_nfe_drafts WHERE tenant_id=$1 AND id=$2`,[c.tenantId,id])).rows[0]
  if (!row) throw new Problem(404,"not_found","Rascunho não encontrado nesta empresa")
  return {tenantId:c.tenantId,canEdit:c.permissions.includes("fiscal.nfe.manage"),data:{id:row.id,revision:revisionValue(row.revision),status:"draft",issuer:row.issuer_snapshot,input:row.details,productsTotal:decimal(BigInt(row.products_total_cents),2),fiscalValidationComplete:false,...(row.ibpt_snapshot?{ibptSnapshot:row.ibpt_snapshot}:{})}}
}
