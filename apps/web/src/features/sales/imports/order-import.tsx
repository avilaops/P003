"use client"
import Link from "next/link"
import { useRouter,useSearchParams } from "next/navigation"
import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/workspace/data-table"
import { useCommand,useResource } from "@/hooks/use-operation"
import { downloadCsv } from "@/lib/csv-export"
import { defaultMapping,exportText,fields,mappedRows,parseOrderCsv,type Csv,type Mapping } from "./order-csv"

type Result={line:number;external:string;status:"ready"|"invalid"|"existing"|"imported";message:string;orderId?:string;orderNumber?:string;amount?:string}
type Summary={id:string;filename:string;channel:string;status:"previewed"|"confirmed";revision:number}
type Job=Summary & {results:Result[]}
type Envelope<T>={tenantId:string;canEdit:boolean;data:T}
const base="/api/erp/sales-imports"
const link=(id:string)=>"/vendas/importacao?job="+encodeURIComponent(id)
const fieldClass="grid gap-1 text-sm font-medium"
const selectClass="h-10 rounded-lg border bg-background px-2"

export function OrderImport() {
  const job=useSearchParams().get("job")
  return <main className="mx-auto max-w-5xl space-y-5 px-4 pb-20 pt-6">
    <PageHeader eyebrow="Vendas" title="Importar pedidos" description="Confira os itens de cada pedido antes de criar os rascunhos."/>
    {job?<ImportReview key={job} id={job}/>:<StartImport/>}
  </main>
}
function StartImport() {
  const access=useResource<Envelope<Summary[]>>(base)
  if(access.loading) return <p role="status">Consultando importações…</p>
  if(access.error || !access.value) return <p role="alert">{access.error || "Importações indisponíveis"} <Button variant="outline" onClick={access.reload}>Tentar novamente</Button></p>
  return <>{access.value.canEdit && <Upload key={access.value.tenantId} tenant={access.value.tenantId}/>}
    <section className="space-y-3"><h2 className="font-semibold">Importações recentes</h2>
      {access.value.data.length?<ul className="divide-y rounded-lg border">{access.value.data.map(job=><li key={job.id}><Link className="block p-3 text-primary underline" href={link(job.id)}>{job.filename} • {job.status==="confirmed"?"Processada":"Prévia"} • {job.channel}</Link></li>)}</ul>:<p>Nenhum arquivo processado nesta empresa.</p>}
    </section></>
}
function Upload({tenant}:{tenant:string}) {
  const [channel,setChannel]=useState("planilha"),[filename,setFilename]=useState(""),[csv,setCsv]=useState<Csv|null>(null)
  const [mapping,setMapping]=useState<Mapping>({}),[error,setError]=useState("")
  const router=useRouter(),command=useCommand()
  const frozen=command.busy || command.uncertain
  async function readFile(file?:File) {
    setError("");setCsv(null);setFilename("")
    if(!file) return
    try {
      if(!/\.csv$/i.test(file.name) || file.size>65536) throw Error("Selecione um arquivo CSV de até 64 KiB.")
      const parsed=parseOrderCsv(new TextDecoder("utf-8",{fatal:true}).decode(await file.arrayBuffer()))
      setFilename(file.name);setCsv(parsed);setMapping(defaultMapping(parsed.headers))
    } catch(err){setError(err instanceof Error?err.message:"Não foi possível ler o arquivo.")}
  }
  async function preview() {
    if(!csv) return
    setError("")
    try {
      const payload={channel,filename,rows:mappedRows(csv,mapping)}
      if(new TextEncoder().encode(JSON.stringify(payload)).length>65536) throw Error("Divida o arquivo em lotes menores. As linhas mapeadas excedem 64 KiB.")
      const result=await command.send<Envelope<Job>>(base+"/preview",tenant,payload)
      if(result?.tenantId===tenant) router.push(link(result.data.id))
    } catch(err){setError(err instanceof Error?err.message:"Prévia indisponível.")}
  }
  return <form className="space-y-4 rounded-lg border p-4" onSubmit={e=>{e.preventDefault();void preview()}}>
    <fieldset className="grid gap-4 sm:grid-cols-2" disabled={frozen}>
      <label className={fieldClass}>Canal de origem<Input required pattern="[a-z0-9]([a-z0-9_]|-){0,47}" value={channel} onChange={e=>setChannel(e.target.value.toLowerCase())}/></label>
      <label className={fieldClass}>Arquivo CSV<Input type="file" accept=".csv,text/csv" onChange={e=>void readFile(e.target.files?.[0])}/></label>
    </fieldset>
    <Button variant="outline" type="button" onClick={()=>downloadCsv("modelo-pedidos.csv",[fields.map(f=>f[2]),["EXT-001","04252011000110","2027-01-31","SKU-001","1","","","","",""]])}>Baixar modelo CSV</Button>
    {csv && <fieldset disabled={frozen} className="space-y-3"><legend className="font-semibold">Mapear colunas</legend>
      <p className="text-sm">Todas as linhas de um mesmo número externo compõem um pedido. Use as colunas de acabamento quando o produto exigir.</p>
      <div className="grid gap-3 sm:grid-cols-2">{fields.map(([key,label],index)=><label key={key} className={fieldClass}>{label}{index>=5?" • opcional":""}<select className={selectClass} value={mapping[key]??-1} onChange={e=>setMapping({...mapping,[key]:Number(e.target.value)})}><option value={-1}>Selecionar coluna</option>{csv.headers.map((header,i)=><option key={i} value={i}>{header}</option>)}</select></label>)}</div>
    </fieldset>}
    {(error || command.error) && <p role="alert">{error || command.error}</p>}
    {csv && <Button type="submit" disabled={command.busy}>{command.uncertain?"Recuperar prévia":"Validar e gerar prévia"}</Button>}
  </form>
}
function ImportReview({id}:{id:string}) {
  const resource=useResource<Envelope<Job>>(base+"/"+encodeURIComponent(id)),command=useCommand()
  if(resource.loading) return <p role="status">Consultando arquivo…</p>
  if(resource.error || !resource.value) return <p role="alert">{resource.error || "Arquivo indisponível"} <Button variant="outline" onClick={resource.reload}>Tentar novamente</Button></p>
  const {data:job,tenantId,canEdit}=resource.value
  const ready=new Set(job.results.filter(r=>r.status==="ready").map(r=>r.external)).size
  const imported=new Set(job.results.filter(r=>r.status==="imported").map(r=>r.orderId)).size
  const existing=job.results.filter(r=>r.status==="existing").length
  const errors=job.results.filter(r=>r.status==="invalid").length
  function download() {
    downloadCsv("resultado-importacao.csv",[["Linha","Pedido externo","Situação","Mensagem","Pedido ERP","Valor"],...job.results.map(r=>[r.line,exportText(r.external),r.status,exportText(r.message),r.orderNumber??"",r.amount??""])])
  }
  return <section className="space-y-4">
    <Link className="text-primary underline" href="/vendas/importacao">Voltar para arquivos</Link>
    <h2 className="font-semibold">{job.status==="previewed"?"Prévia":"Resultado"} • {job.filename}</h2>
    <p>{job.channel} • {job.results.length} linhas • {errors} com erro • {job.status==="previewed"?ready+" pedidos prontos":imported+" pedidos criados"}</p>
    <div className="overflow-x-auto"><DataTable aria-label="Resultado por linha"><thead><tr><th>Linha</th><th>Pedido externo</th><th>Resultado</th><th>Pedido ERP</th></tr></thead><tbody>{job.results.map(r=><tr key={r.line}><td>{r.line}</td><td>{r.external}</td><td>{r.message}</td><td>{r.orderId?<Link className="text-primary underline" href={"/vendas/pedidos/"+r.orderId}>PV-{r.orderNumber}</Link>:""}</td></tr>)}</tbody></DataTable></div>
    <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" onClick={download}>Baixar relatório CSV</Button>
      {job.status==="previewed" && canEdit && <Button disabled={(!ready && !existing) || command.busy || command.stale} onClick={async()=>{
        const result=await command.send<Envelope<Job>>(base+"/"+id+"/confirm",tenantId,{},resource.etag)
        if(result?.tenantId===tenantId) resource.reload()
      }}>{command.uncertain?"Conferir importação":"Confirmar pedidos válidos"}</Button>}</div>
    {command.error && <p role="alert">{command.error} {command.stale && <Button variant="outline" onClick={resource.reload}>Atualizar prévia</Button>}</p>}
  </section>
}
