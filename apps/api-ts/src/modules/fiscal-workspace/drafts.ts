import {validateOwnReturnDraft} from "./self-returns.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,replay,remember,record } from "../../platform/commands.js"
import { nextRevision,parseRevision,revisionValue } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { checkOrderSource,conflict,decimalValue,guid,invalid,issuerData,loadDraft,sourcePreparation,type ObjectData } from "./draft-data.js"
import { ibptSnapshot,ibptQuote } from "./ibpt.js"
import { draftInputSchema,type DraftInput } from "./draft-schema.js"
import { applyOperationType } from "../fiscal/operation-types/model.js"

export async function certificateStatus(c:AuthorizedContext,deps:AppDependencies) {
  const row=(await c.client.query<{tax_id:string;revision:string|null;metadata:ObjectData|null}>(`SELECT t.tax_id,a.revision,a.metadata FROM tenants t LEFT JOIN fiscal_a1_certificates a ON a.tenant_id=t.id WHERE t.id=$1`,[c.tenantId])).rows[0]!
  const meta=row.metadata,now=Date.now()/1000
  let status="not_configured"
  if(meta) {
    if(meta.taxId!==row.tax_id) status="company_mismatch"
    else if(Number(meta.validFrom)>now) status="not_yet_valid"
    else if(Number(meta.validUntil)<=now) status="expired"
    else try {
      if(!deps.fiscalOperations) throw Error()
      await deps.fiscalOperations.material(c)
      status=Number(meta.validUntil)-now<=30*86400 ? "expiring":"active"
    } catch {status="unavailable"}
  }
  return {tenantId:c.tenantId,revision:revisionValue(row.revision ?? 0),canEdit:c.permissions.includes("fiscal.certificate.manage"),uploadAvailable:!!deps.fiscalOperations && !!deps.fiscalVault,
    companyTaxId:row.tax_id,status,data:meta}
}

export async function validateDraft(c:AuthorizedContext,draft:DraftInput,transmit=false) {
  const issuer=await issuerData(c)
  if (!issuer || !issuer.valid) throw new Problem(409,"invalid_issuer","Confira o cadastro e a configuração fiscal do emitente")
  const profile={...issuer.profile,environment:draft.environment,crt:draft.crt ?? issuer.profile.crt,series:draft.series ?? issuer.profile.series}
  if (![55,65].includes(draft.model) || !["homologation","production"].includes(draft.environment) || !draft.items.length || !draft.operationNature.trim() || !draft.taxRuleReference.trim()) invalid("Confira o modelo, o ambiente e a instrução fiscal")
  // F1: o tipo de operação define CFOP e CSTs; ao transmitir, tipo incompleto bloqueia com mensagem clara.
  await applyOperationType(c,draft,String(issuer.profile.state),transmit)
  if (!/^\d{11}(\d{3})?$/.test(draft.recipient.taxId) && !(draft.recipient.state==="EX" && draft.recipient.foreignId)) invalid("Confira o documento do destinatário")
  if(draft.departureAt && (!draft.issuedAt || !Number.isFinite(Date.parse(draft.departureAt)) || Date.parse(draft.departureAt)<Date.parse(draft.issuedAt))) invalid("A saída deve ocorrer na data de emissão ou depois")
  if(draft.model===65 && (draft.departureAt || draft.finalConsumer===false || draft.purpose && draft.purpose!==1 || draft.sourceOrderId)) invalid("Dados incompatíveis com o modelo 65")
  if(draft.issuedAt && !z.iso.datetime({offset:true}).safeParse(draft.issuedAt).success) invalid("Data de emissão inválida")
  let gross=0n
  for(const item of draft.items){
    const quantity=decimalValue(item.quantity,4),unit=decimalValue(item.unitPrice,10),itemGross=decimalValue(item.grossTotal,2)
    if (!item.code.trim() || item.code.length>60 || !item.description.trim() || !item.unit.trim() || !/^\d{8}$/.test(item.ncm) || !/^\d{4}$/.test(item.cfop) ||
      quantity<=0n || unit<=0n || itemGross<=0n || (quantity*unit+500000000000n)/1000000000000n!==itemGross) invalid("Confira os códigos, quantidades, preços e totais dos itens")
    gross+=itemGross
  }
  if (gross>999999999999999n || gross!==decimalValue(draft.productsTotal,2)) invalid("Total dos produtos incompatível com as linhas fiscais")
  if(draft.financialCategoryId && !(await c.client.query("SELECT id FROM financial_categories WHERE tenant_id=$1 AND id=$2 AND status='active' AND direction='income'",[c.tenantId,draft.financialCategoryId])).rows.length) invalid("Categoria financeira da receita inválida")
  await checkOrderSource(c,draft)
  if(draft.purpose===4) {
    const partial=draft.sourceReturnKind==="sale_partial_return",sale=partial || draft.sourceReturnKind==="sale_cancellation"
    if (!(sale ? draft.returnDirection==="incoming" : draft.sourceReturnKind==="purchase_reversal" && draft.returnDirection==="outgoing") || !draft.sourceReturnId || !draft.referencedAccessKeys?.length) invalid("Devolução exige a origem comercial e sua chave de referência")
    requirePermission(c,sale ? "sales.orders.read":"purchasing.orders.read")
    const exists=await c.client.query(`SELECT id FROM ${partial ? "sales_self_return_plans":sale ? "sales_order_cancellations":"purchase_receipt_reversals"} WHERE tenant_id=$1 AND id=$2`,[c.tenantId,draft.sourceReturnId])
    if (!exists.rows.length) conflict("A origem da devolução não foi encontrada nesta empresa")
    if(partial)await validateOwnReturnDraft(c,draft)
  } else if(draft.sourceReturnId || draft.sourceReturnKind || draft.returnDirection) invalid("Origem de devolução incompatível com a finalidade")
  return {gross,issuer:{taxId:issuer.taxId,legalName:issuer.legalName,company:issuer.company,companyRevision:issuer.companyRevision,profileRevision:issuer.profileRevision,profile}}
}

export function registerFiscalDrafts(app:FastifyInstance,deps:AppDependencies) {
  const prefix="/api/v1/fiscal"
  app.post(prefix+"/ibpt/quote",async(r,reply)=>{
    const quote=await authorizeRequest(r,deps,async c=>{
      requirePermission(c,"fiscal.nfe.read")
      return ibptQuote(c.tenantId,r.body)
    },false)
    return reply.header("cache-control","no-store").send(quote)
  })
  app.get(prefix+"/readiness",async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const issuer=await issuerData(c), cert=await certificateStatus(c,deps), profile=issuer?.profile
    const production=!!deps.fiscalOperations?.production(c.tenantId), environment=profile?.environment || "homologation",blockers:string[]=[]
    const verified=["active","expiring"].includes(cert.status)
    if(!deps.fiscalOperations)blockers.push("fiscal_engine_not_configured")
    if(!verified)blockers.push("a1_certificate_missing_expired_or_unavailable")
    if(!issuer)blockers.push("fiscal_profile_missing")
    else {
      if(!issuer.valid)blockers.push("company_and_fiscal_profile_inconsistent")
      if(profile?.state!=="SP")blockers.push("homologation_emission_requires_sp")
      if(![1,3].includes(Number(profile?.crt)))blockers.push("homologation_emission_requires_supported_tax_rule_scope")
      if(environment==="production" && !production)blockers.push("production_emission_disabled")
    }
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,environment,model:55,canTransmit:!blockers.length,productionEnabled:production,certificateVerified:verified,profileConfigured:!!issuer,crt:profile?.crt,series:profile?.series,nextNumber:profile?.nextNumber,blockers})
  }))
  app.get(prefix+"/certificate",async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.config.read")
    const data=await certificateStatus(c,deps)
    return reply.header("cache-control","no-store").header("etag",`"${data.revision}"`).send(data)
  }))
  app.get(prefix+"/config",async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.config.read")
    const issuer=await issuerData(c),cert=await certificateStatus(c,deps),profile=issuer?.profile, revision=issuer?.profileRevision ?? 0
    const sequence=profile ? (await c.client.query("SELECT next_number FROM fiscal_number_sequences WHERE tenant_id=$1 AND model=55 AND environment=$2 AND series=$3",[c.tenantId,profile.environment,profile.series])).rows[0]:undefined
    return reply.header("cache-control","no-store").header("etag",`"${revision}"`).send({tenantId:c.tenantId,revision,canEdit:c.permissions.includes("fiscal.config.manage"),certificateVerified:["active","expiring"].includes(cert.status),data:profile?{...profile,...(sequence ? {nextNumber:Number(sequence.next_number)}:{})}:null})
  }))
  app.get<{Params:{id:string}}>(prefix+"/order-preparations/:id",async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    return reply.header("cache-control","no-store").send(await sourcePreparation(c,guid(request.params.id)))
  }))
  app.get<{Params:{section:string}}>(prefix+"/settings/:section",async(request,reply)=>authorizeRequest(request,deps,async c=>{
    const section=request.params.section
    const defaults:Record<string,unknown>={nfce:null,"operation-natures":{items:[]},delivery:{notificationEmail:null,authorizedPeople:[]}}
    if(!Object.hasOwn(defaults,section)) throw new Problem(404,"not_found","Seção fiscal inexistente")
    if(section!=="operation-natures" || !c.permissions.includes("fiscal.nfe.read")) requirePermission(c,"fiscal.config.read")
    const row=(await c.client.query("SELECT revision,data FROM fiscal_preferences WHERE tenant_id=$1 AND section=$2",[c.tenantId,section])).rows[0]
    const revision=revisionValue(row?.revision ?? 1)
    return reply.header("cache-control","no-store").header("etag",`"${revision}"`).send({tenantId:c.tenantId,revision,canEdit:c.permissions.includes("fiscal.config.manage"),secretStorageAvailable:!!deps.fiscalVault,data:row?.data ?? defaults[section]})
  }))
  for(const resource of ["nfe","issued-nfes"] as const)app.get(prefix+"/"+resource,async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const query=z.strictObject({cursor:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).safeParse(request.query)
    if(!query.success)return invalid("Confira o cursor e o limite da página fiscal")
    const {cursor,limit}=query.data
    const sql=resource==="nfe" ? `SELECT id,revision,'draft' AS status,issuer_snapshot AS issuer,details AS input,
        (products_total_cents/100::numeric)::numeric(17,2)::text AS "productsTotal",false AS "fiscalValidationComplete",ibpt_snapshot AS "ibptSnapshot",created_at AS "createdAt"
        FROM fiscal_nfe_drafts WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`
      : `SELECT e.tenant_id AS "tenantId",e.id,e.revision,e.status,e.environment,e.model,e.series,e.number::int,e.access_key AS "accessKey",e.protocol,e.result,
        e.source_order_id AS "sourceOrderId",e.source_return_id AS "sourceReturnId",e.source_return_kind AS "sourceReturnKind",e.issued_at AS "issuedAt",
        d.details->'recipient'->>'legalName' AS "recipientName",d.details->'recipient'->>'taxId' AS "recipientTaxId",d.details->>'productsTotal' AS amount
        FROM fiscal_nfe_documents e LEFT JOIN fiscal_nfe_drafts d ON d.tenant_id=e.tenant_id AND d.id=e.id WHERE e.tenant_id=$1 AND ($2::uuid IS NULL OR e.id<$2)
        ORDER BY e.id DESC LIMIT $3`
    const rows=(await c.client.query(sql,[c.tenantId,cursor,limit+1])).rows
    const data=rows.slice(0,limit).map(row=>({...row,id:row.id,revision:revisionValue(row.revision)}))
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,data,nextCursor:rows.length>limit?data.at(-1)?.id:null})
  }))
  app.get<{Params:{id:string}}>(prefix+"/nfe/:id",async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const current=await loadDraft(c,guid(request.params.id))
    return reply.header("cache-control","no-store").header("etag",`"${current.data.revision}"`).send(current)
  }))
  for(const method of ["POST","PUT"] as const) {
    const create=method==="POST"
    app.route<{Params:{id?:string}}>({method,url:prefix+"/nfe"+(create?"":"/:id"),bodyLimit:1024*1024,handler:async(request,reply)=>{
      const id=create?randomUUID():guid(request.params.id),key=create?commandKey(request.headers["idempotency-key"]):undefined,expected=create?0:parseRevision(request.headers["if-match"])
      const parsed=draftInputSchema.safeParse(request.body)
      if(!parsed.success) invalid("Confira o formato dos campos do rascunho fiscal")
      const draft=parsed.data!
      const saved=await authorizeRequest(request,deps,async c=>{
        requirePermission(c,"fiscal.nfe.read");requirePermission(c,"fiscal.nfe.manage")
        if(key){const previous=await replay(c,key,"fiscal.nfe.draft.create",draft);if(previous)return previous}
        const current=create?undefined:await loadDraft(c,id)
        if(current && current.data.revision!==expected) throw new Problem(412,"revision_conflict","O rascunho foi atualizado")
        if(current && (await c.client.query("SELECT id FROM fiscal_nfe_documents WHERE tenant_id=$1 AND id=$2 AND (signed_xml IS NOT NULL OR lease_until>clock_timestamp())",[c.tenantId,id])).rows.length) conflict("A emissão já começou. Consulte o documento antes de editar")
        const ownReturn=current?.data.input.sourceReturnKind==="sale_partial_return"
        if((draft.sourceReturnKind==="sale_partial_return" || ownReturn) &&
          (!ownReturn || draft.sourceReturnKind!=="sale_partial_return" || draft.sourceReturnId!==id))
          conflict("A nota de entrada própria é vinculada pelo pedido de origem")
        const {gross,issuer}=await validateDraft(c,draft)
        const revision=create?1:nextRevision(expected)
        const frozen=await ibptSnapshot(c.tenantId,draft)
        const values=[c.tenantId,id,draft.environment,draft.model,issuer.profileRevision,issuer.companyRevision,issuer,draft,gross,draft.sourceReturnId,draft.sourceReturnKind,frozen]
        if(create) await c.client.query(`INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents,source_return_id,source_return_kind,ibpt_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,values)
        else await c.client.query(`UPDATE fiscal_nfe_drafts SET environment=$3,model=$4,profile_revision=$5,company_revision=$6,issuer_snapshot=$7,details=$8,products_total_cents=$9,
          source_return_id=$10,source_return_kind=$11,ibpt_snapshot=$12,updated_at=now(),revision=$13 WHERE tenant_id=$1 AND id=$2`,[...values,revision])
        await record(c,request.headers,"nfe_draft",id,create?"fiscal.nfe.draft.created":"fiscal.nfe.draft.updated",{model:draft.model,environment:draft.environment,revision})
        const snapshot=await loadDraft(c,id)
        if(key)await remember(c,key,"fiscal.nfe.draft.create",draft,snapshot)
        return snapshot
      })
      return reply.code(create?201:200).header("cache-control","no-store").header("etag",`"${(saved.data as ObjectData).revision}"`).send(saved)
    }})
  }
}
