import {parseXml,child,children,value as xmlValue,fiscalDecimal} from "../fiscal-incoming/xml.js"
import {randomUUID} from "node:crypto"
import {z} from "zod"
import type {AuthorizedContext} from "../../platform/access.js"
import {requirePermission} from "../../platform/access.js"
import {record} from "../../platform/commands.js"
import type {CommandHeaders} from "../orders/receivables.js"
import {decimal,fixed} from "../sales/fixed.js"
import {conflict,invalid} from "./draft-data.js"
import {draftInputSchema,type DraftInput} from "./draft-schema.js"
import {validateDraft} from "./drafts.js"
import {returnPolicy,returnReviewer} from "./return-policy.js"
import {applyPartialReturn,matchItems} from "./partial-return.js"
import {metadata} from "./outgoing-imports.js"
import {renderDanfe,sha256} from "../nfe-email/danfe.js"

const env=z.enum(["production","homologation"])
const noPendingCancellation="NOT EXISTS (SELECT 1 FROM fiscal_nfe_events ev WHERE ev.tenant_id=d.tenant_id AND ev.document_id=d.id AND ev.kind='cancelamento' AND ev.status IN('pending','unknown'))"
export const ownStart=z.strictObject({action:z.literal("prepareOwnReturn"),environment:env,lotId:z.guid(),reason:z.string().trim().min(3).max(200),
  destination:z.enum(["stock","service","discard"]),taxRuleReference:z.string().trim().min(3).max(200),consumerDeclaration:z.literal(true),
  items:z.array(z.strictObject({lineNumber:z.number().int().min(1).max(990),quantityMicros:z.string().regex(/^[1-9]\d{0,17}$/).refine(v=>BigInt(v)%100n===0n),cfop:z.string().regex(/^[12]\d{3}$/)})).min(1).max(990)})
export const ownDecision=z.strictObject({action:z.literal("decideOwnReturn"),environment:env,planId:z.guid(),approve:z.boolean(),reason:z.string().trim().min(3).max(200)})
export const ownRelease=z.strictObject({action:z.literal("releaseOwnReturn"),environment:env,planId:z.guid()})
export const ownClose=z.strictObject({action:z.literal("completeOwnReturn"),environment:env,planId:z.guid()})
type Start=z.infer<typeof ownStart>
type Selection={lineNumber:number;sku:string;unit:string;unitPrice:string;quantityMicros:string;cfop:string;valueCents:string}
type Plan={id:string;lot_id:string;environment:string;status:string;submitted_by:string;reason:string;destination:"stock"|"service"|"discard";items:Selection[];original_key:string;original_authorized:boolean;customer:string;amount_cents:string}
async function plan(c:AuthorizedContext,id:string,order?:string){
  const result=(await c.client.query<Plan>(`SELECT p.*,o.customer_tax_id AS customer,coalesce(d.status='authorized' AND d.access_key=p.original_key AND d.environment=p.environment AND ${noPendingCancellation},false) AS original_authorized
    FROM sales_self_return_plans p JOIN sales_orders o ON (o.tenant_id,o.id)=(p.tenant_id,p.order_id)
    JOIN sales_invoice_lots l ON (l.tenant_id,l.id)=(p.tenant_id,p.lot_id)
    LEFT JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(l.tenant_id,l.draft_id)
    WHERE p.tenant_id=$1 AND p.id=$2 AND ($3::uuid IS NULL OR o.id=$3)`,[c.tenantId,id,order??null])).rows[0]
  if(!result)return conflict("Solicitação de devolução não encontrada")
  return result
}
export async function validateOwnReturnDraft(c:AuthorizedContext,d:DraftInput){
  const p=await plan(c,d.sourceReturnId!)
  if(!p.original_authorized)conflict("A nota de origem deve permanecer autorizada para a devolução")
  if(!["ready","pending"].includes(p.status) || d.sourceOrderId || d.model!==55 || d.purpose!==4 || d.returnDirection!=="incoming" ||
    d.environment!==p.environment || d.recipient.taxId!==p.customer || d.referencedAccessKeys?.length!==1 || d.referencedAccessKeys[0]!==p.original_key ||
    d.items.length!==p.items.length)conflict("Emitente, consumidor, ambiente e referência devem corresponder à devolução")
  for(const [i,row] of d.items.entries()){
    const original=p.items[i]!
    if(row.code!==original.sku || row.unit!==original.unit || row.cfop!==original.cfop || fixed(row.quantity,4)*100n!==BigInt(original.quantityMicros) ||
      fixed(row.unitPrice,10)!==fixed(original.unitPrice,10))conflict("Os itens fiscais devem manter as quantidades, CFOP e preços da devolução")
  }
}
export async function prepareOwnReturn(c:AuthorizedContext,headers:CommandHeaders,order:string,input:Start){
  const source=(await c.client.query<{details:DraftInput;access_key:string;days:number|null;customer:string}>(`SELECT fd.details,d.access_key,o.customer_tax_id AS customer,
    (now() AT TIME ZONE 'America/Sao_Paulo')::date-(l.delivered_at AT TIME ZONE 'America/Sao_Paulo')::date AS days FROM sales_invoice_lots l
    JOIN sales_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id) JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(l.tenant_id,l.draft_id)
    JOIN fiscal_nfe_drafts fd ON (fd.tenant_id,fd.id)=(d.tenant_id,d.id) WHERE l.tenant_id=$1 AND l.id=$2 AND o.id=$3 AND l.environment=$4
    AND (l.delivered_at IS NOT NULL OR l.environment='homologation') AND d.status='authorized' AND d.model=55 AND ${noPendingCancellation} AND coalesce((fd.details->>'purpose')::int,1)=1`,[c.tenantId,input.lotId,order,input.environment])).rows[0]
  if(!source || !source.access_key || source.details.recipient?.taxId!==source.customer || source.details.finalConsumer===false ||
    source.details.taxDeclaration?.recipientTaxpayer) return conflict("Selecione uma saída autorizada para consumidor sem nota própria no ambiente do lote")
  const policy=await returnPolicy(c)
  if(input.environment==="production" && policy.windowDays!==null && (source.days===null || source.days>policy.windowDays))conflict("O prazo de devolução contado da entrega deste lote expirou")
  const open=await c.client.query(`SELECT id FROM sales_self_return_plans WHERE tenant_id=$1 AND lot_id=$2 AND status IN('pending','ready')
    UNION ALL SELECT id FROM sales_return_requests WHERE tenant_id=$1 AND lot_id=$2 AND status='pending'`,[c.tenantId,input.lotId])
  if(open.rows.length)conflict("Conclua a devolução já em andamento neste lote")
  if(new Set(input.items.map(i=>i.lineNumber)).size!==input.items.length)invalid("Selecione cada linha apenas uma vez")
  const lines=(await c.client.query<{line_number:number;sku:string;unit:string;price:string;unit_price:string;qty:string;prior:string;global_qty:string;remaining_money:string}>(`SELECT l.line_number,s.sku,s.unit,s.price_cents AS price,order_line_fiscal_price(s) AS unit_price,
    l.quantity_micros AS qty,coalesce((SELECT sum(r.quantity_micros) FROM sales_partial_return_items r WHERE r.tenant_id=l.tenant_id AND r.lot_id=l.lot_id AND r.line_number=l.line_number),0)
      +CASE WHEN $4='homologation' THEN coalesce((SELECT sum((e->>'quantityMicros')::numeric) FROM sales_self_return_plans p CROSS JOIN LATERAL jsonb_array_elements(p.items) e WHERE p.tenant_id=l.tenant_id AND p.lot_id=l.lot_id AND p.status='simulated' AND (e->>'lineNumber')::int=l.line_number),0) ELSE 0 END AS prior,
    order_line_delivered(s.tenant_id,s.order_id,s.line_number)-returned.quantity-settled.exchange-pending.quantity AS global_qty,
    s.amount_cents-returned.amount-settled.credit-pending.amount AS remaining_money FROM sales_invoice_lot_items l JOIN sales_order_lines s USING(tenant_id,order_id,line_number)
    CROSS JOIN LATERAL sales_pending_return_balance(s.tenant_id,s.order_id,s.line_number) pending
    LEFT JOIN LATERAL (SELECT coalesce(sum(r.quantity_micros),0) AS quantity,coalesce(sum(r.value_cents),0) AS amount FROM sales_partial_return_items r JOIN sales_invoice_lots o ON (o.tenant_id,o.id)=(r.tenant_id,r.lot_id)
      WHERE o.tenant_id=l.tenant_id AND o.order_id=l.order_id AND r.line_number=l.line_number) returned ON true
    LEFT JOIN LATERAL (SELECT coalesce(sum(w.quantity_micros) FILTER(WHERE kind='exchange'),0) AS exchange,coalesce(sum(w.amount_cents) FILTER(WHERE kind IN('credit','refund')),0) AS credit FROM warranty_settlements w
      WHERE w.tenant_id=l.tenant_id AND w.order_id=l.order_id AND w.line_number=l.line_number) settled ON true
    WHERE l.tenant_id=$1 AND l.lot_id=$2 AND l.order_id=$3 ORDER BY l.line_number`,[c.tenantId,input.lotId,order,input.environment])).rows
  const selected:Selection[]=[],draftItems:DraftInput["items"]=[]
  let gross=0n,amount=0n
  for(const choice of [...input.items].sort((a,b)=>a.lineNumber-b.lineNumber)){
    const line=lines.find(l=>l.line_number===choice.lineNumber),qty=BigInt(choice.quantityMicros)
    const original=line && source.details.items.find(i=>i.code===line.sku && i.unit===line.unit)
    if(!line || !original || !line.unit_price || qty+BigInt(line.prior)>BigInt(line.qty))return conflict("A quantidade supera o saldo faturado da linha")
    const before=BigInt(line.prior),prior=BigInt(line.qty),rounded=(v:bigint,d:bigint)=>(v+d/2n)/d
    const prorate=(v:bigint)=>rounded((before+qty)*v,prior)-rounded(before*v,prior)
    const value=rounded((before+qty)*BigInt(line.price),1000000n)-rounded(before*BigInt(line.price),1000000n)
    if(input.environment==="production" && (qty>BigInt(line.global_qty) || value>BigInt(line.remaining_money)))conflict("A quantidade ou o valor já foi compensado por outra devolução ou garantia")
    const unit=decimal(BigInt(line.unit_price)*100000000n,10),total=rounded(qty*BigInt(line.unit_price),1000000n)
    if(total<=0n)invalid("A quantidade selecionada deve resultar em valor fiscal positivo")
    const lineInput={...original,quantity:decimal(qty/100n,4),unitPrice:unit,grossTotal:decimal(total,2),cfop:choice.cfop,exportDetails:[],referencedDfe:null}
    for(const field of ["discountAmount","freightAmount","insuranceAmount","otherAmount"] as const)if(original[field])lineInput[field]=decimal(prorate(fixed(original[field],2)),2)
    if(original.taxableQuantity)lineInput.taxableQuantity=decimal(prorate(fixed(original.taxableQuantity,4)),4)
    draftItems.push(lineInput);gross+=total;amount+=value
    selected.push({...choice,sku:line.sku,unit:line.unit,unitPrice:unit,valueCents:value.toString()})
  }
  const id=randomUUID(),status=policy.approvalAboveCents!==null && amount>BigInt(policy.approvalAboveCents)?"pending":"ready"
  await c.client.query(`INSERT INTO sales_self_return_plans(tenant_id,id,order_id,lot_id,environment,original_key,reason,destination,submitted_by,amount_cents,status,items)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[c.tenantId,id,order,input.lotId,input.environment,source.access_key,input.reason,input.destination,c.authSubject,amount,status,JSON.stringify(selected)])
  const value={model:55,environment:input.environment,purpose:4,returnDirection:"incoming",sourceReturnKind:"sale_partial_return",sourceReturnId:id,
    referencedAccessKeys:[source.access_key],operationNature:"Devolução de venda",taxRuleReference:input.taxRuleReference,recipient:source.details.recipient,items:draftItems,
    productsTotal:decimal(gross,2),taxDeclaration:source.details.taxDeclaration,finalConsumer:true,freightMode:draftItems.some(i=>i.freightAmount && fixed(i.freightAmount,2)>0n)?source.details.freightMode:"9",
    payments:[{code:"90",amount:"0.00"}],additionalInformation:input.reason}
  const parsed=draftInputSchema.safeParse(value)
  if(!parsed.success)return conflict("O cadastro fiscal da nota de origem está incompleto para preparar a devolução")
  const {issuer}=await validateDraft(c,parsed.data)
  await c.client.query(`INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents,source_return_id,source_return_kind)
      VALUES($1,$2,$3,55,$4,$5,$6,$7,$8,$2,'sale_partial_return')`,[c.tenantId,id,input.environment,issuer.profileRevision,issuer.companyRevision,issuer,parsed.data,gross])
  await record(c,headers,"nfe_draft",id,"fiscal.nfe.draft.created",{origin:"sale_partial_return",orderId:order,lotId:input.lotId,status})
  return {id,status}
}
export async function changeOwnReturn(c:AuthorizedContext,order:string,input:z.infer<typeof ownDecision>|z.infer<typeof ownRelease>){
  const p=await plan(c,input.planId,order)
  if(p.environment!==input.environment)conflict("Confira o ambiente da devolução")
  let status:string,reason:string|null=null
  if(input.action==="decideOwnReturn"){
    if(!returnReviewer(c) || p.submitted_by===c.authSubject) return conflict("Outra pessoa com alçada deve decidir a solicitação")
    if(p.status!=="pending")conflict("Esta solicitação não aguarda decisão")
    status=input.approve?"ready":"declined";reason=input.reason
  } else {
    const doc=(await c.client.query("SELECT status FROM fiscal_nfe_documents WHERE tenant_id=$1 AND id=$2",[c.tenantId,p.id])).rows[0]
    if(!["pending","ready"].includes(p.status) || doc && !["rejected","cancelled"].includes(String(doc.status)))conflict("A nota já tem emissão em andamento ou confirmada")
    status="withdrawn"
  }
  await c.client.query("UPDATE sales_self_return_plans SET status=$3,decision_by=$4,decision_reason=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,p.id,status,c.authSubject,reason])
  return {id:p.id,status}
}
export async function ownEvidence(c:AuthorizedContext,order:string,id:string,render:typeof renderDanfe){
  const p=await plan(c,id,order)
  const row=(await c.client.query<{authorized_xml:string;access_key:string;tax_id:string}>(`SELECT d.authorized_xml,d.access_key,t.tax_id FROM fiscal_nfe_documents d JOIN tenants t ON t.id=d.tenant_id
    WHERE d.tenant_id=$1 AND d.id=$2 AND d.model=55 AND d.source_return_kind='sale_partial_return' AND d.source_return_id=$2 AND d.environment=$3 AND d.status='authorized' AND ${noPendingCancellation}`,[c.tenantId,p.id,p.environment])).rows[0]
  if(!row || !p.original_authorized || p.status!=="ready")return conflict("Aguarde a autorização da nota de entrada própria antes de concluir")
  await render({xml:row.authorized_xml,issuerTaxId:row.tax_id,accessKey:row.access_key,environment:p.environment})
  return sha256(row.authorized_xml)
}
export async function completeOwnReturn(c:AuthorizedContext,headers:CommandHeaders,order:string,input:z.infer<typeof ownClose>,digest:string){
  const p=await plan(c,input.planId,order)
  const note=(await c.client.query<{authorized_xml:string;access_key:string;tax_id:string}>(`SELECT d.authorized_xml,d.access_key,t.tax_id FROM fiscal_nfe_documents d JOIN tenants t ON t.id=d.tenant_id
    WHERE d.tenant_id=$1 AND d.id=$2 AND d.source_return_kind='sale_partial_return' AND d.source_return_id=$2 AND d.status='authorized' AND d.environment=$3 AND ${noPendingCancellation}`,[c.tenantId,p.id,p.environment])).rows[0]
  if(!note || !p.original_authorized || p.status!=="ready" || input.environment!==p.environment || sha256(note.authorized_xml)!==digest) return conflict("A evidência da emissão mudou. Consulte a nota de entrada")
  const n=metadata(note.authorized_xml)
  if(n.direction!=="0" || n.key!==note.access_key || n.issuer!==note.tax_id || n.recipient!==p.customer || n.env!==(p.environment==="production"?1:2))conflict("O protocolo não corresponde à entrada da empresa")
  const info=child(child(parseXml(note.authorized_xml),"NFe"),"infNFe"),ide=child(info,"ide"),refs=children(ide,"NFref"),lines=children(info,"det")
  if(xmlValue(ide,"finNFe")!=="4" || refs.length!==1 || xmlValue(refs[0]!,"refNFe")!==p.original_key || lines.length!==p.items.length)conflict("A NF-e de entrada não referencia a venda e os itens aprovados")
  for(const [index,line] of lines.entries()){
    const item=child(line,"prod"),s=p.items[index]!
    if(xmlValue(item,"cProd")!==s.sku || xmlValue(item,"uCom")!==s.unit || xmlValue(item,"CFOP")!==s.cfop ||
      fiscalDecimal(xmlValue(item,"qCom"),6)!==BigInt(s.quantityMicros) || fiscalDecimal(xmlValue(item,"vUnCom"),10)!==fixed(s.unitPrice,10))conflict("Os itens do XML não correspondem à solicitação comercial")
  }
  const existing=await c.client.query("SELECT id FROM fiscal_received_nfes WHERE tenant_id=$1 AND access_key=$2",[c.tenantId,n.key])
  if(existing.rows.length)conflict("A chave da entrada já foi arquivada. Confira a origem do documento")
  const archived=(await c.client.query<{id:string}>(`INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id,own_return_document_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,(SELECT id FROM identities WHERE auth_subject=$14),$15) RETURNING id`,
    [c.tenantId,n.key,n.issuer,n.issuerName,n.recipient,n.number,n.series,n.issuedAt,n.total,n.quantity,n.env,note.authorized_xml,digest,c.authSubject,p.id])).rows[0]!
  let returnId:string|null=null
  if(p.environment==="production"){
    for(const perm of ["inventory.stock.manage","finance.receivables.manage","fiscal.received_nfe.manage"])requirePermission(c,perm)
    const business={lotId:p.lot_id,receivedId:archived.id,reason:p.reason,destination:p.destination}
    const items=await matchItems(c,order,business,digest,p.id)
    if(items.length!==p.items.length || items.some(i=>!p.items.some(s=>s.lineNumber===i.line && s.quantityMicros===i.quantity && s.valueCents===i.value)))conflict("A nota autorizada diverge da devolução aprovada")
    returnId=await applyPartialReturn(c,headers,order,business,items)
  }
  const status=p.environment==="production"?"applied":"simulated"
  await c.client.query("UPDATE sales_self_return_plans SET status=$3,received_id=$4,return_id=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,p.id,status,archived.id,returnId])
  return {id:p.id,status}
}
