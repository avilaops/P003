import {createHash} from "node:crypto"
import {open,lstat} from "node:fs/promises"
import {basename,dirname,join} from "node:path"
import {z} from "zod"
import {Problem} from "../../platform/problem.js"
import {decimal} from "../sales/fixed.js"
import {decimalValue,invalid} from "./draft-data.js"
import type {DraftInput} from "./draft-schema.js"

const uf=z.enum(["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"])
const classification=z.enum(["ncm","nbs","lc116"]),version=z.string().regex(/^\d{2}\.\d\.[A-Z]$/),ex=z.string().regex(/^\d{1,3}$/)
const text=z.string().trim().min(1).max(200).refine(s=>!/[\u0000-\u001f\u007f]/.test(s))
const rate=z.string().regex(/^\d{1,3}\.\d{4}$/).refine(s=>decimalValue(s,4)<=1000000n)
const row=z.strictObject({code:z.string().regex(/^\d+$/),ex,national:rate,imported:rate,state:rate,municipal:rate})
const table=z.strictObject({uf,classification,version,source:text,key:text,validFrom:z.iso.date(),validTo:z.iso.date(),licenseReference:text,rows:z.array(row).min(1).max(20000)})
const manifest=z.array(z.strictObject({tenantId:z.guid(),file:z.string().min(1).max(255).refine(s=>basename(s)===s && !/[\\/:]/.test(s) && s!=="." && s!==".."),sha256:z.string().regex(/^[a-f0-9]{64}$/i)})).max(81)
const lengths={ncm:8,nbs:9,lc116:4}
const input=z.strictObject({uf,classification,version:version.nullable().optional(),origin:z.enum(["national","imported"]),ex,code:z.string().regex(/^\d+$/),amount:z.string().regex(/^\d{1,13}\.\d{2}$/),asOf:z.iso.date()})
type Metadata=Omit<z.infer<typeof table>,"rows"|"licenseReference">&{sha256:string}
type Data={tenant:string;meta:Metadata;rows:Map<string,z.infer<typeof row>>}
async function bounded(path:string,maximum:number) {
  if((await lstat(path)).isSymbolicLink())throw Error("IBPT symlink")
  const handle=await open(path,"r")
  try{
    const stat=await handle.stat()
    if(!stat.isFile() || stat.size>maximum)throw Error("IBPT size")
    const bytes=Buffer.alloc(stat.size)
    let used=0
    while(used<bytes.length){const {bytesRead}=await handle.read(bytes,used,bytes.length-used,used);if(!bytesRead)throw Error("IBPT changed");used+=bytesRead}
    if((await handle.stat()).size!==bytes.length)throw Error("IBPT changed")
    return bytes
  }finally{await handle.close()}
}
async function load(path:string){
  if(/^[/\\]{2}|^[a-z]+:\/\//i.test(path))throw Error("IBPT local")
  const entries=manifest.parse(JSON.parse((await bounded(path,65536)).toString("utf8")))
  const maps=new Map<string,Data>()
  let total=0
  for(const entry of entries){
    const bytes=await bounded(join(dirname(path),entry.file),10*1024*1024),hash=createHash("sha256").update(bytes).digest("hex")
    total+=bytes.length
    if(hash!==entry.sha256.toLowerCase() || total>100*1024*1024)throw Error("IBPT integrity")
    const {rows,licenseReference,...meta}=table.parse(JSON.parse(bytes.toString("utf8")))
    if(!licenseReference || meta.validFrom>meta.validTo)throw Error("IBPT validity")
    const key=[entry.tenantId.toLowerCase(),meta.uf,meta.classification,meta.version].join(":")
    const mapped=new Map(rows.map(r=>[r.code+":"+r.ex,r]))
    if(mapped.size!==rows.length || rows.some(r=>r.code.length!==lengths[meta.classification]) || maps.has(key) && maps.get(key)!.meta.sha256!==hash)throw Error("IBPT duplicate")
    maps.set(key,{tenant:entry.tenantId.toLowerCase(),meta:{...meta,sha256:hash},rows:mapped})
  }
  return [...maps.values()].sort((a,b)=>b.meta.validFrom.localeCompare(a.meta.validFrom)||b.meta.version.localeCompare(a.meta.version))
}
let cached:{path:string;data:Promise<Data[]>}|undefined
async function catalog(file=process.env.ERP_IBPT_MANIFEST_FILE) {
  if(!file)return []
  if(!cached || cached.path!==file)cached={path:file,data:load(file)}
  try{return await cached.data}catch{cached=undefined;throw new Problem(503,"ibpt_unavailable","O catálogo local de tributos aproximados não passou pela conferência")}
}
const notice="Estimativa informativa dos tributos aproximados da operação."
export async function ibptQuote(tenantId:string,raw:unknown,file?:string){
  const parsed=input.safeParse(raw)
  if(!parsed.success || parsed.data.code.length!==lengths[parsed.data.classification])return invalid("Confira a UF, data, classificação, origem, código e versão IBPT")
  const v=parsed.data,candidates=(await catalog(file)).filter(t=>t.tenant===tenantId && t.meta.uf===v.uf && t.meta.classification===v.classification && (!v.version || t.meta.version===v.version))
  const selected=candidates.find(t=>t.meta.validFrom<=v.asOf && v.asOf<=t.meta.validTo)
  const record=selected?.rows.get(v.code+":"+v.ex)
  if(!selected || !record)return {tenantId,status:selected?"code_not_found":candidates.length?"outside_validity":"not_configured",metadata:(selected??candidates[0])?.meta??null,amounts:null,notice}
  const amount=decimalValue(v.amount,2),rounded=(rate:string)=>(amount*decimalValue(rate,4)+500000n)/1000000n
  const federal=rounded(record[v.origin]),state=rounded(record.state),municipal=rounded(record.municipal)
  return {tenantId,status:"available",metadata:selected.meta,amounts:{federal:decimal(federal,2),state:decimal(state,2),municipal:decimal(municipal,2),total:decimal(federal+state+municipal,2)},notice}
}
export async function ibptSnapshot(tenantId:string,draft:DraftInput,file?:string){
  const choice=draft.ibpt
  if(!choice)return null
  if(choice.items.length!==draft.items.length || draft.issuedAt && draft.issuedAt.slice(0,10)!==choice.asOf)return invalid("Confira a data de emissão e os itens da seleção IBPT")
  const sums={federal:0n,state:0n,municipal:0n,total:0n},items=[]
  for(const [i,item] of draft.items.entries()){
    const selection=choice.items[i]!,rate=draft.taxDeclaration?.ipiRate,net=decimalValue(item.grossTotal,2)+decimalValue(item.freightAmount??"0.00",2)+decimalValue(item.insuranceAmount??"0.00",2)+decimalValue(item.otherAmount??"0.00",2)-decimalValue(item.discountAmount??"0.00",2)
    const base=net+(net*decimalValue(rate??"0.0000",4)+500000n)/1000000n
    if(base<0n || base>999999999999999n)return invalid("Base IBPT fora do limite fiscal")
    const amount=decimal(base,2),quote=await ibptQuote(tenantId,{...selection,uf:choice.uf,asOf:choice.asOf,amount,classification:"ncm",code:item.ncm},file)
    if(!quote.amounts || !quote.metadata)throw new Problem(409,"ibpt_not_available","Confira a vigência, a versão e o NCM do catálogo IBPT da empresa")
    for(const k of ["federal","state","municipal","total"] as const){sums[k]+=decimalValue(quote.amounts[k],2);if(sums[k]>999999999999999n)return invalid("Total IBPT acima do limite fiscal")}
    items.push({itemCode:item.code,code:item.ncm,ex:selection.ex,origin:selection.origin,amount,metadata:quote.metadata,amounts:quote.amounts})
  }
  return {tenantId,uf:choice.uf,asOf:choice.asOf,items,amounts:Object.fromEntries(Object.entries(sums).map(([k,v])=>[k,decimal(v,2)]))}
}
