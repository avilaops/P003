import { createHash } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { orderInputSchema } from "../orders/schema.js"
import { prepareImportedOrder } from "./pricing.js"
import { storeQuote } from "../commercial/quote-document.js"
import { persistDraft } from "../orders/persist-draft.js"
import { decimal } from "../sales/fixed.js"

const cell=z.string().max(220)
export const channelCode=z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/)
const importRow=z.strictObject({
  line:z.number().int().min(2).max(100000), external:cell, customer:cell, due:cell, sku:cell, quantity:cell,
  structureColor:cell.optional(),swingArmColor:cell.optional(),plateHolderColor:cell.optional(),plateHolderType:cell.optional(),upholsteryColor:cell.optional()
})
export const previewSchema=z.strictObject({filename:z.string().trim().min(1).max(160),channel:channelCode,rows:z.array(importRow).min(1).max(200)})
export type ImportRow=z.infer<typeof importRow>
export type ImportResult={line:number;external:string;status:"ready"|"invalid"|"existing"|"imported";message:string;orderId?:string;orderNumber?:string;amount?:string;previewDigest?:string}
type Trace=Parameters<typeof record>[1]
function problem(title:string):never { throw new Problem(422,"invalid_import_row",title) }

function normalize(row:ImportRow) {
  const raw=row.quantity.trim().replace(",",".")
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(raw)) problem("Informe quantidade positiva com até seis casas decimais")
  const [whole,fraction=""]=raw.split(".")
  const quantity=BigInt(whole!)*1000000n + BigInt(fraction.padEnd(6,"0"))
  if (quantity<=0n) problem("Quantidade deve ser positiva")
  const customer=row.customer.trim().replace(/[.\/\s-]/g,"")
  if (!/^(?:\d{11}|\d{14})$/.test(customer)) problem("CPF/CNPJ de cliente inválido")
  if (!row.external.trim() || row.external.trim().length>120 || /\p{Cc}/u.test(row.external.trim())) problem("Número externo ausente ou inválido")
  if (!row.sku.trim()) problem("SKU ausente")
  return {external:row.external.trim(),customer,due:row.due.trim(),sku:row.sku.trim(),quantity:decimal(quantity,6),
    structureColor:row.structureColor?.trim()||undefined,swingArmColor:row.swingArmColor?.trim()||undefined,
    plateHolderColor:row.plateHolderColor?.trim()||undefined,plateHolderType:row.plateHolderType?.trim()||undefined,upholsteryColor:row.upholsteryColor?.trim()||undefined}
}

export async function evaluate(c:AuthorizedContext, channel:string,rows:ImportRow[], confirm?:{id:string;trace:Trace;preview:ImportResult[]}) {
  const groups=new Map<string,ImportRow[]>()
  const numbered=new Set<number>()
  for(const row of rows) {
    if (numbered.has(row.line)) throw new Problem(422,"invalid_input","O arquivo contém números de linha repetidos")
    numbered.add(row.line)
    const group=row.external.trim()
    groups.set(group,[...(groups.get(group) ?? []),row])
  }
  const results:ImportResult[]=[]
  for(const [external,group] of groups) {
    let sourceLine:number|undefined
    try {
      const normalized=group.map(row=>{sourceLine=row.line;return normalize(row)})
      sourceLine=undefined
      const first=normalized[0]!
      if (normalized.some(row=>row.customer!==first.customer || row.due!==first.due)) problem("Um pedido externo deve manter o mesmo cliente e vencimento em todas as linhas")
      const digest=createHash("sha256").update(canonicalJson([...normalized].sort((a,b)=>a.sku<b.sku?-1:a.sku>b.sku?1:0))).digest("hex")
      const existing=(await c.client.query(`SELECT co.order_id,co.input_digest,o.number::text,o.amount_cents FROM sales_channel_orders co JOIN sales_orders o ON o.tenant_id=co.tenant_id AND o.id=co.order_id WHERE co.tenant_id=$1 AND co.channel=$2 AND co.external_number=$3`,[c.tenantId,channel,external])).rows[0]
      if (existing) {
        if (existing.input_digest!==digest) problem("Número externo já utilizado com conteúdo diferente")
        for(const row of group) results.push({line:row.line,external,status:"existing",message:"Pedido já recebido",orderId:String(existing.order_id),orderNumber:String(existing.number),amount:decimal(BigInt(String(existing.amount_cents)),2)})
        continue
      }
      if (confirm && group.some(row=>confirm.preview.find(p=>p.line===row.line)?.status!=="ready")) {
        results.push(...confirm.preview.filter(p=>group.some(row=>row.line===p.line)))
        continue
      }
      const customer=(await c.client.query("SELECT id FROM parties WHERE tenant_id=$1 AND is_customer AND status='active' AND tax_id=$2",[c.tenantId,first.customer])).rows
      if(customer.length!==1) problem("Cliente ativo não encontrado de forma única pelo CPF/CNPJ")
      const items=[]
      for(const [index,row] of normalized.entries()) {
        sourceLine=group[index]!.line
        const product=(await c.client.query("SELECT id FROM products WHERE tenant_id=$1 AND status='active' AND sku=$2",[c.tenantId,row.sku])).rows[0]
        if(!product) problem("SKU ativo não encontrado")
        const {sku:_,external:_ext,customer:_customer,due:_due,...item}=row
        items.push({...item,productId:product.id})
      }
      sourceLine=undefined
      const parsed=orderInputSchema.safeParse({customerId:String(customer[0]!.id),dueDate:first.due,items})
      if (!parsed.success) problem("Dados de pedido incompatíveis com o cadastro")
      const input=parsed.data
      const {draft:prepared,quote}=await prepareImportedOrder(c,input,channel)
      const amount=decimal(prepared.total,2)
      const previewDigest=createHash("sha256").update(canonicalJson({customer:input.customerId,prepared,...(quote?{commercialDigest:quote.prepared.digest}:{})})).digest("hex")
      if(confirm && group.some(row=>{
        const preview=confirm.preview.find(p=>p.line===row.line)
        return preview?.amount!==amount || preview.previewDigest!==undefined && preview.previewDigest!==previewDigest
      })) problem("O preço mudou desde a prévia. Gere nova prévia para confirmar")
      const created=confirm?await persistDraft(c,confirm.trace,input.customerId,prepared):null
      if (created && confirm) {
        if(quote) await storeQuote(c,created.id,quote.simulation,quote.prepared)
        await c.client.query("INSERT INTO sales_channel_orders(tenant_id,channel,external_number,input_digest,order_id,import_id) VALUES($1,$2,$3,$4,$5,$6)",[c.tenantId,channel,external,digest,created.id,confirm.id])
        await record(c,confirm.trace,"sales_order",created.id,"order.channel_imported",{channel,externalNumber:external,importId:confirm.id,status:"draft"})
      }
      for(const row of group) results.push({line:row.line,external,amount,previewDigest,status:created?"imported":"ready",message:created?"Pedido em rascunho":"Pronto para importar",...(created?{orderId:created.id,orderNumber:created.number}:{})})
    } catch(error) {
      if (!(error instanceof Problem) || error.status>=500 || error.status===403) throw error
      for(const row of group) results.push({line:row.line,external,status:"invalid",message:sourceLine && sourceLine!==row.line?`Pedido bloqueado pela linha ${sourceLine} • ${error.title}`:error.title})
    }
  }
  return results.sort((a,b)=>a.line-b.line)
}
