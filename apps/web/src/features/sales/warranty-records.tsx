"use client"

import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { useCommand, useResource } from "@/hooks/use-operation"

type RecordItem={id:string;kind:"evidence"|"report"|"term";title:string;createdAt:string;contractId:string|null;info:{filename?:string;cause?:string;diagnosis?:string;conclusion?:string;scheduledAt?:string;status?:string}}
type Contract={id:string;name:string;status:string;accepted:boolean|null}
type Props={id:string;orderId:string|null;tenant:string;etag:string;writable:boolean;orders:{id:string;status:string}[];reload:()=>void}
const stages={scheduled:"Agendada",in_repair:"Em reparo",awaiting_parts:"Aguardando peças",completed:"Concluída"}

function fileData(file:File) {
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader()
    reader.onload=()=>resolve(String(reader.result).split(",")[1] || "")
    reader.onerror=()=>reject(new Error("A leitura do arquivo falhou"))
    reader.readAsDataURL(file)
  })
}

export function WarrantyRecords({id,orderId,tenant,etag,writable,orders,reload}:Props) {
  const url="/api/erp/warranty-cases/"+id+"/records"
  const activity=useResource<{contracts:Contract[];canReadTerms:boolean;records:RecordItem[]}>(url)
  const command=useCommand()
  const [kind,setKind]=useState<RecordItem["kind"]>("evidence")
  const [error,setError]=useState("")
  const [reading,setReading]=useState(false)
  const [status,setStatus]=useState<keyof typeof stages>("in_repair")
  const contracts=activity.value?.contracts ?? []
  const available=orders.filter(order=>!["completed","cancelled"].includes(order.status))
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault()
    if(reading || command.busy) return
    if(command.uncertain){
      if(await command.send(url,tenant,{},etag)) reload()
      return
    }
    const fields=new FormData(e.currentTarget),field=(name:string)=>String(fields.get(name) ?? "").trim()
    const common={kind,title:field("title")}
    setError("")
    setReading(true)
    try{
      let input
      if(kind==="evidence"){
        const file=fields.get("file")
        if(!(file instanceof File) || !file.size || file.size>10*1024*1024) throw new Error("Selecione um arquivo de até 10 MB.")
        input={...common,filename:file.name,mediaType:file.type,base64:await fileData(file)}
      }else if(kind==="term") input={...common,contractId:field("contract")}
      else input={...common,serviceOrderId:field("service"),cause:field("cause"),diagnosis:field("diagnosis"),conclusion:field("conclusion"),status,scheduledAt:field("scheduledAt")?new Date(field("scheduledAt")).toISOString():null}
      if(await command.send(url,tenant,input,etag)) reload()
    }catch(reason){setError(reason instanceof Error?reason.message:"Confira os dados do registro.")}
    finally{setReading(false)}
  }
  return <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Evidências, laudos e termos</h2>
    {activity.loading && <p role="status">Consultando registros…</p>}
    {activity.error && <p role="alert">{activity.error} <Button variant="outline" onClick={activity.reload}>Tentar novamente</Button></p>}
    {activity.value && !activity.value.records.length && <p>Nenhum registro anexado ao protocolo.</p>}
    {activity.value?.records.map(item=><article className="grid gap-1 border-b pb-2" key={item.id}>
      <strong>{item.title}</strong>
      {item.kind==="evidence" && <a className="text-primary underline" href={"/api/erp/warranty-evidence/"+item.id+"/file"} download>{item.info.filename}</a>}
      {item.kind==="report" && <><p>Causa • {item.info.cause}</p><p>Diagnóstico • {item.info.diagnosis}</p><p>Conclusão • {item.info.conclusion}</p><p>{stages[item.info.status as keyof typeof stages]}{item.info.scheduledAt && " • "+new Date(item.info.scheduledAt).toLocaleString("pt-BR")}</p></>}
      {item.kind==="term" && <Link className="text-primary underline" href={"/servicos/contratos/"+item.contractId}>{contracts.find(c=>c.id===item.contractId)?.accepted?"Aceite confirmado":"Consultar assinaturas do termo"}</Link>}
    </article>)}
    {writable && activity.value && <form className="space-y-2" onSubmit={submit}>
      <fieldset className="grid gap-2" disabled={reading || command.busy || command.uncertain || command.stale}>
        <label>Tipo de registro<select className="block min-h-10 rounded border bg-background" value={kind} onChange={e=>setKind(e.target.value as RecordItem["kind"])}>
          <option value="evidence">Evidência</option><option value="report" disabled={!available.length}>Laudo de ordem de serviço</option>
          {activity.value.canReadTerms && orderId && <option value="term">Termo do pedido</option>}
        </select></label>
        <label>Título do registro<Input name="title" required minLength={3} maxLength={160}/></label>
        {kind==="evidence" && <label>Foto, vídeo ou PDF de até 10 MB<Input type="file" name="file" required accept="image/jpeg,image/png,video/mp4,application/pdf"/></label>}
        {kind==="report" && <><label>Ordem de serviço do laudo<select name="service" required>{available.map((o,n)=><option key={o.id} value={o.id}>Ordem {n+1}</option>)}</select></label>
          <label>Causa identificada<Input name="cause" required minLength={2} maxLength={160}/></label>
          <label>Diagnóstico técnico<textarea className="block w-full rounded border p-2" name="diagnosis" required minLength={3} maxLength={4000}/></label>
          <label>Conclusão do laudo<textarea className="block w-full rounded border p-2" name="conclusion" required minLength={3} maxLength={4000}/></label>
          <label>Situação da ordem<select value={status} onChange={e=>setStatus(e.target.value as keyof typeof stages)}>{Object.entries(stages).map(([code,label])=><option key={code} value={code}>{label}</option>)}</select></label>
          <label>Agendamento da assistência<Input name="scheduledAt" type="datetime-local" required={status==="scheduled"}/></label></>}
        {kind==="term" && <><label>Documento para assinatura<select name="contract" required defaultValue=""><option value="">Selecione</option>{contracts.map(c=><option key={c.id} value={c.id}>{c.name} • {c.accepted?"Aceite confirmado":"Em acompanhamento"}</option>)}</select></label>
          <Link className="text-primary underline" href={"/vendas/pedidos/"+orderId+"/contratos"}>Preparar termo no módulo de contratos</Link></>}
      </fieldset>
      {command.stale?<Button type="button" variant="outline" onClick={reload}>Atualizar protocolo</Button>:<Button type="submit" disabled={reading || command.busy || kind==="term" && !contracts.length}>{command.uncertain?"Conferir registro":"Salvar registro"}</Button>}
      {(error || command.error) && <p role="alert">{error || command.error}</p>}
    </form>}
  </section>
}
