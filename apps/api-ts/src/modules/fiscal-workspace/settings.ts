import type { FastifyInstance } from "fastify"
import {z} from "zod"
import type {AppDependencies} from "../../app.js"
import {authorizeRequest,requirePermission,type AuthorizedContext} from "../../platform/access.js"
import {record} from "../../platform/commands.js"
import {nextRevision,parseRevision,revisionValue} from "../../platform/revision.js"
import {Problem} from "../../platform/problem.js"
import {validDocument} from "../parties/schema.js"
import {certificateStatus} from "./drafts.js"
import {conflict,invalid} from "./draft-data.js"

const ufCodes:Record<string,string>={AC:"12",AL:"27",AP:"16",AM:"13",BA:"29",CE:"23",DF:"53",ES:"32",GO:"52",MA:"21",MT:"51",MS:"50",MG:"31",PA:"15",PB:"25",PR:"41",PE:"26",PI:"22",RJ:"33",RN:"24",RS:"43",RO:"11",RR:"14",SC:"42",SP:"35",SE:"28",TO:"17"}
const state=z.string().refine(v=>Object.hasOwn(ufCodes,v)),environment=z.enum(["production","homologation"]),series=z.int().min(1).max(999),number=z.int().min(1).max(999999999)
const profile=z.strictObject({environment,state,municipalityCode:z.string().regex(/^\d{7}$/),stateRegistration:z.string().regex(/^\d{1,14}$/),crt:z.int().min(1).max(4),series,nextNumber:number.optional(),certificateReference:z.string().regex(/^(?:[A-Za-z0-9_-]{3,100})?$/).default("")})
const nfce=z.strictObject({environment,state,series,nextNumber:number,cscId:z.string().regex(/^\d{1,6}$/),csc:z.string().regex(/^[A-Za-z0-9-]{16,36}$/).optional()})
const clean=(n:number)=>z.string().trim().min(1).max(n).refine(s=>!/[\u0000-\u001f\u007f]/.test(s))
const cfop=z.string().regex(/^(?:\d{4})?$/)
const nature=z.strictObject({id:z.uuid(),code:clean(30),name:clean(60),direction:z.enum(["incoming","outgoing"]),purpose:z.int().min(1).max(4),model:z.union([z.literal(55),z.literal(65)]),internalCfop:cfop,interstateCfop:cfop,foreignCfop:cfop})
  .refine(v=>[v.internalCfop,v.interstateCfop,v.foreignCfop].every((f,i)=>!f || f[0]===(v.direction==="incoming"?"123":"567")[i]))
const unique=(v:string[])=>new Set(v).size===v.length
const natures=z.strictObject({items:z.array(nature).max(200)}).refine(v=>unique(v.items.map(i=>i.id)) && unique(v.items.map(i=>i.code.toLowerCase())))
const email=z.email().max(254),tax=z.string().regex(/^[\d./ -]+$/).transform(v=>v.replace(/\D/g,"")).refine(v=>validDocument(v,v.length===11?"fisica":"juridica"))
const contact=z.strictObject({id:z.uuid(),name:clean(120),role:clean(60),email,taxId:tax,active:z.boolean()})
const delivery=z.strictObject({notificationEmail:email.nullable(),authorizedPeople:z.array(contact).max(50)}).refine(v=>
  unique(v.authorizedPeople.map(p=>p.id)) && unique(v.authorizedPeople.map(p=>p.taxId)) && unique(v.authorizedPeople.map(p=>p.email.toLowerCase())))
function manage(c:AuthorizedContext){requirePermission(c,"fiscal.config.read");requirePermission(c,"fiscal.config.manage")}
export const initialRevision=(header:string|string[]|undefined)=>header==='"0"'?0:parseRevision(header)
const stale=()=>new Problem(412,"revision_conflict","A configuração fiscal foi atualizada")
async function setNumber(c:AuthorizedContext,model:number,env:string,series:number,next:number) {
  const result=await c.client.query(`INSERT INTO fiscal_number_sequences(tenant_id,environment,model,series,next_number) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(tenant_id,environment,model,series) DO UPDATE SET next_number=excluded.next_number WHERE fiscal_number_sequences.next_number<=excluded.next_number RETURNING next_number`,[c.tenantId,env,model,series,next])
  if(!result.rows.length)conflict("A próxima numeração deve respeitar os números já reservados")
}
export function registerFiscalSettings(app:FastifyInstance,deps:AppDependencies){
  app.put("/api/v1/fiscal/config",async(r,reply)=>{
    const result=await authorizeRequest(r,deps,async c=>{
      manage(c)
      const parsed=profile.safeParse(r.body)
      if(!parsed.success)return invalid("Confira a identificação fiscal, a série e a numeração")
      const v=parsed.data
      if(!v.municipalityCode.startsWith(ufCodes[v.state]!) || v.environment==="production" && !v.nextNumber)return invalid("Confira o município da UF e a próxima numeração")
      const company=(await c.client.query("SELECT details FROM company_profiles WHERE tenant_id=$1",[c.tenantId])).rows[0]?.details as Record<string,unknown>|undefined
      if(!company || company.personType!=="juridica" || company.state!==v.state || company.stateRegistration!==v.stateRegistration ||
        !(company.taxRegime==="simples"?[1,2,4].includes(v.crt):["presumido","real"].includes(String(company.taxRegime)) && v.crt===3))return conflict("O perfil fiscal precisa corresponder ao cadastro da empresa")
      const row=(await c.client.query("SELECT revision FROM fiscal_profiles WHERE tenant_id=$1",[c.tenantId])).rows[0]
      const current=revisionValue(row?.revision??0)
      if(initialRevision(r.headers["if-match"])!==current)throw stale()
      if(v.nextNumber)await setNumber(c,55,v.environment,v.series,v.nextNumber)
      const revision=nextRevision(current)
      await c.client.query(`INSERT INTO fiscal_profiles(tenant_id,revision,environment,details) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,environment=excluded.environment,details=excluded.details,updated_at=now()`,[c.tenantId,revision,v.environment,v])
      await record(c,r.headers,"fiscal_profile",c.tenantId,"fiscal.profile.updated",{revision,environment:v.environment,series:v.series})
      return {tenantId:c.tenantId,revision,canEdit:true,certificateVerified:["active","expiring"].includes((await certificateStatus(c,deps)).status),data:v}
    })
    return reply.header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result)
  })
  app.put<{Params:{section:string}}>("/api/v1/fiscal/settings/:section",async(r,reply)=>{
    const result=await authorizeRequest(r,deps,async c=>{
      manage(c)
      const section=r.params.section,row=(await c.client.query("SELECT revision,data FROM fiscal_preferences WHERE tenant_id=$1 AND section=$2",[c.tenantId,section])).rows[0]
      if(!["nfce","operation-natures","delivery"].includes(section))throw new Problem(404,"not_found","Seção fiscal inexistente")
      const current=revisionValue(row?.revision??1)
      if(parseRevision(r.headers["if-match"])!==current)throw stale()
      const next=nextRevision(current)
      let data:unknown,sealed:ReturnType<NonNullable<AppDependencies["fiscalVault"]>["seal"]>|undefined,context:string|undefined
      if(section==="nfce"){
        const val=nfce.safeParse(r.body)
        if(!val.success)return invalid("Confira o ambiente, série, CSC e numeração da NFC-e")
        const {csc,...v}=val.data,vault=deps.fiscalVault
        if(!vault)return conflict("Configure o cofre fiscal da empresa antes de cadastrar o CSC")
        const old=row?.data as Record<string,unknown>|undefined
        if(!csc && (old?.environment!==v.environment || old?.cscId!==v.cscId || old?.state!==v.state))return invalid("Informe o CSC ao cadastrar ou alterar o ambiente, UF ou identificador")
        const secret=csc??(await vault.nfceSecret(c,v.environment)).csc.secret
        const taxId=(await c.client.query("SELECT tax_id FROM tenants WHERE id=$1",[c.tenantId])).rows[0]!.tax_id
        context=["avila-erp:nfce-csc:v1",c.tenantId,taxId,v.environment,v.cscId,next].join(":")
        const buffer=Buffer.from(secret)
        try{sealed=vault.seal(context,buffer)}finally{buffer.fill(0)}
        await setNumber(c,65,v.environment,v.series,v.nextNumber)
        data={...v,cscConfigured:true}
      }else{
        const val=(section==="delivery"?delivery:natures).safeParse(r.body)
        if(!val.success)return invalid("Confira os campos e os registros repetidos nesta configuração fiscal")
        data=val.data
      }
      await c.client.query(`INSERT INTO fiscal_preferences(tenant_id,section,revision,data,secret_key_id,secret_nonce,secret_ciphertext,secret_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(tenant_id,section) DO UPDATE SET revision=excluded.revision,data=excluded.data,secret_key_id=excluded.secret_key_id,secret_nonce=excluded.secret_nonce,
        secret_ciphertext=excluded.secret_ciphertext,secret_context=excluded.secret_context,updated_at=now()`,[c.tenantId,section,next,data,sealed?.keyId,sealed?.nonce,sealed?.ciphertext,context])
      await record(c,r.headers,"fiscal_preferences",c.tenantId,"fiscal.preferences.updated",{section,revision:next})
      return {tenantId:c.tenantId,revision:next,canEdit:true,secretStorageAvailable:!!deps.fiscalVault,data}
    })
    return reply.header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result)
  })
}
