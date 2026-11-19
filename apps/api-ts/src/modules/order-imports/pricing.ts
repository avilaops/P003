import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { mixedInputSchema } from "../commercial/mixed-model.js"
import { prepareMixed } from "../commercial/mixed-prepare.js"
import { quoteLines } from "../commercial/quote-document.js"
import { customerSnapshotSql, validateFiscalCustomer } from "../sales/customer-fiscal.js"
import { fixed, validateDate } from "../sales/fixed.js"
import { prepareOrder } from "../orders/prepare.js"
import type { OrderInput } from "../orders/schema.js"

export async function publishedProducts(c:AuthorizedContext, ids:string[]) {
 return (await c.client.query<{id:string;line:string;version:string;origin:string}>(`
 SELECT p.product_id AS id,s.product_line AS line,s.active_price_version_id AS version,v.policy_snapshot->>'originState' AS origin
 FROM commercial_settings s JOIN price_table_versions v ON (v.tenant_id,v.id)=(s.tenant_id,s.active_price_version_id)
 JOIN price_table_items p ON (p.tenant_id,p.version_id)=(s.tenant_id,s.active_price_version_id)
 WHERE s.tenant_id=$1 AND p.product_id=ANY($2::uuid[])`,[c.tenantId,ids])).rows
}
export async function prepareImportedOrder(c:AuthorizedContext, input:OrderInput,channel:string){
 const published=await publishedProducts(c,input.items.map(i=>i.productId))
 if(!published.length)return {draft:await prepareOrder(c,input,undefined,channel),quote:null}
 const customer=(await c.client.query<{data:{legalName:string;taxId:string;personType:string;addresses:{state?:string;primary?:boolean}[];fiscal:{taxpayerIndicator?:string;stateRegistration?:string}|null}}>(customerSnapshotSql,[c.tenantId,input.customerId])).rows[0]?.data
 if(!customer)throw new Problem(422,"invalid_input","Cliente ativo não encontrado")
 const addresses=customer.addresses??[]
 const preferred=addresses.find(a=>a.primary)?.state,states=[...new Set(addresses.map(a=>a.state).filter(Boolean))]
 const destinationState=preferred??(states.length===1?states[0]:undefined)
 if(!destinationState)throw new Problem(422,"invalid_input","Indique uma UF de entrega principal no cadastro do cliente")
 const taxpayer=customer.personType==="juridica" && customer.fiscal?.taxpayerIndicator==="1" && !!customer.fiscal.stateRegistration
 const items=input.items.map(item=>{
  const sources=published.filter(p=>p.id===item.productId)
  if(sources.length!==1)throw new Problem(422,"invalid_input","O pedido do canal precisa de uma publicação vigente e única para cada equipamento")
  const micros=fixed(item.quantity,6)
  if(micros%1000000n!==0n)throw new Problem(422,"invalid_input","A tabela publicada exige quantidade inteira por equipamento")
  return {productId:item.productId,line:sources[0]!.line,versionId:sources[0]!.version,quantity:Number(micros/1000000n),
   structureColor:item.structureColor??null,swingArmColor:item.swingArmColor??null,plateHolderColor:item.plateHolderColor??null,
   plateHolderType:item.plateHolderType??null,upholsteryColor:item.upholsteryColor??null}
 })
 const parsed=mixedInputSchema.safeParse({items,customerId:input.customerId,channel,destinationState,taxpayer,discount:{kind:"percent",value:0},freightCents:0,downPaymentCents:null})
 if(!parsed.success)throw new Problem(422,"invalid_input","Quantidade ou dados comerciais inválidos para a tabela")
 const simulation=parsed.data
 validateFiscalCustomer(customer,simulation)
 const prepared=await prepareMixed(c,simulation)
 const draft={due:validateDate(input.dueDate),customerName:customer.legalName,customerTaxId:customer.taxId,total:BigInt(prepared.sale.totalCents),lines:await quoteLines(c,prepared)}
 return {draft,quote:{simulation,prepared}}
}
