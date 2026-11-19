"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand } from "@/hooks/use-operation"
import type { SalesMember } from "./opportunity-pipeline-model"

const types={call:"Ligação",visit:"Visita",email:"E-mail"}
export type Activity={id:string;kind:keyof typeof types;subject:string;dueDate:string;ownerName:string;completedAt:string|null}

export function PipelineActivities({id,tenant,canEdit,members,activities,etag,reload}:{id:string;tenant:string;canEdit:boolean;members:SalesMember[];activities:Activity[];etag:string;reload:()=>void}) {
  const cmd=useCommand()
  const [kind,setKind]=useState("call"),[subject,setSubject]=useState(""),[dueDate,setDue]=useState(""),[ownerId,setOwner]=useState("")
  const [pending,setPending]=useState<string|null>(null)
  const base="/api/erp/opportunities/"+id+"/activities", frozen=cmd.busy||cmd.uncertain||cmd.stale
  async function send(target:string) {
    setPending(target)
    const saved=await cmd.send(target==="new"?base:base+"/"+target+"/complete",tenant,target==="new"?{kind,subject,dueDate,ownerId}:{},etag)
    if(saved) reload()
  }
  return <section className="space-y-3 rounded-lg border bg-card p-4"><h2 className="font-semibold">Atividades</h2>
    {activities.length?<ul className="divide-y">{activities.map(a=><li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><strong>{a.subject}</strong><p className="text-sm">{types[a.kind]} • {a.dueDate.split("-").reverse().join("/")} • {a.ownerName} • {a.completedAt?"Concluída":"Pendente"}</p></div>
      {!a.completedAt && canEdit && <Button variant="outline" disabled={cmd.busy||cmd.stale||cmd.uncertain&&pending!==a.id} onClick={()=>void send(a.id)}>{cmd.uncertain&&pending===a.id?"Conferir conclusão":"Concluir atividade"}</Button>}</li>)}</ul>:<p className="text-sm">Nenhuma atividade registrada.</p>}
    {canEdit && members.length>0 && <form onSubmit={e=>{e.preventDefault();void send("new")}} className="space-y-2">
      <fieldset disabled={frozen} className="grid gap-2 text-sm sm:grid-cols-2">
        <label className="grid gap-1">Tipo de atividade<select className="rounded border p-2" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(types).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="grid gap-1">Assunto<Input required maxLength={240} value={subject} onChange={e=>setSubject(e.target.value)}/></label>
        <label className="grid gap-1">Prazo da atividade<Input type="date" required value={dueDate} onChange={e=>setDue(e.target.value)}/></label>
        <label className="grid gap-1">Responsável pela atividade<select required className="rounded border p-2" value={ownerId} onChange={e=>setOwner(e.target.value)}><option value="">Selecionar</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      </fieldset><Button type="submit" disabled={cmd.busy||cmd.stale||cmd.uncertain&&pending!=="new"}>{cmd.uncertain?"Conferir agendamento":"Agendar atividade"}</Button>
    </form>}{cmd.error && <p role="alert">{cmd.error} {cmd.stale&&<Button variant="outline" onClick={reload}>Atualizar oportunidade</Button>}</p>}
  </section>
}
