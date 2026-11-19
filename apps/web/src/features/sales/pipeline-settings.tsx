"use client"
import { useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useResource,useCommand } from "@/hooks/use-operation"
import type { StageOption } from "./opportunity-pipeline-model"
const url="/api/erp/opportunities/settings"
type Config={tenantId:string;canEdit:boolean;data:{stages:StageOption[];revision:number}}
export function PipelineSettings() {
  const r=useResource<Config>(url)
  return <main className="mx-auto max-w-3xl space-y-4 p-4"><PageHeader eyebrow="Vendas • Funil" title="Etapas do funil"/><Link className="text-primary underline" href="/vendas/funil">Voltar ao funil</Link>
    {r.loading?<p role="status">Carregando etapas…</p>:r.error||!r.value?<p role="alert">{r.error} <Button onClick={r.reload}>Tentar novamente</Button></p>:<Editor key={r.value.tenantId+r.etag} value={r.value} etag={r.etag} reload={r.reload}/>}</main>
}
function Editor({value,etag,reload}:{value:Config;etag:string;reload:()=>void}) {
  const [stages,setStages]=useState(value.data.stages),[saved,setSaved]=useState(false)
  const command=useCommand(),disabled=!value.canEdit||command.busy||command.uncertain||command.stale
  function move(index:number,delta:number) {
    const next=[...stages],other=index+delta
    if(other<0||other>=stages.length)return
    ;[next[index],next[other]]=[next[other]!,next[index]!]
    setStages(next)
  }
  return <form className="space-y-3" onSubmit={async e=>{e.preventDefault();const r=await command.send(url,value.tenantId,{stages},etag,"PUT");if(r){setSaved(true);reload()}}}>
    <p className="text-sm">A ordem define as colunas do quadro. Arquivar uma etapa preserva o histórico das oportunidades.</p>
    <fieldset disabled={disabled} className="space-y-2">{stages.map((stage,index)=><div key={stage.code} className="flex flex-wrap items-end gap-2 rounded-lg border p-2">
      <label className="grid flex-1 text-sm">Nome da etapa<Input required maxLength={60} value={stage.label} onChange={e=>setStages(stages.map(s=>s.code===stage.code?{...s,label:e.target.value}:s))}/></label>
      <label className="p-2 text-sm"><input type="checkbox" checked={stage.active} disabled={["new","proposed","won","lost"].includes(stage.code)} onChange={e=>setStages(stages.map(s=>s.code===stage.code?{...s,active:e.target.checked}:s))}/> Ativa</label>
      <Button type="button" variant="outline" aria-label={"Subir "+stage.label} disabled={index===0} onClick={()=>move(index,-1)}>↑</Button><Button type="button" variant="outline" aria-label={"Descer "+stage.label} disabled={index===stages.length-1} onClick={()=>move(index,1)}>↓</Button>
    </div>)}
    {value.canEdit&&<Button type="button" variant="outline" disabled={stages.length>=30} onClick={()=>setStages([...stages,{code:"custom-"+crypto.randomUUID().slice(0,8),label:"",active:true}])}>Adicionar etapa</Button>}</fieldset>
    {value.canEdit&&<Button type="submit" disabled={command.busy||command.stale}>{command.uncertain?"Conferir gravação":"Salvar etapas"}</Button>}
    {command.error&&<p role="alert">{command.error} {command.stale&&<Button variant="outline" onClick={reload}>Recarregar etapas</Button>}</p>}{saved&&<p role="status">Etapas salvas.</p>}
  </form>
}
