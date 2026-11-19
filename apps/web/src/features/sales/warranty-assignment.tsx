"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand } from "@/hooks/use-operation"
import { Lookup } from "./orders"

type AssignmentResponse = {
  tenantId: string
  data: {
    id: string
    queue: string
    assignedTo: string | null
    assignedToName?: string | null
    slaDueAt: string | null
    revision: number
  }
}

export function WarrantyAssignment({ item, tenantId, etag, onSaved }: { item: AssignmentResponse["data"]; tenantId: string; etag: string; onSaved: () => void }) {
  const command = useCommand()
  const [queue, setQueue] = useState(item.queue)
  const [assignedTo, setAssignedTo] = useState(item.assignedTo || "")
  const [name,setName]=useState(item.assignedToName || "")
  const [slaDueAt, setSlaDueAt] = useState(() => {
    if (!item.slaDueAt) return ""
    const local = new Date(item.slaDueAt)
    return new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  })

  async function save() {
    const result = await command.send(`/api/erp/warranty-cases/${item.id}/assignment`, tenantId, {
      queue: queue.trim(),
      assignedTo: assignedTo.trim() || null,
      slaDueAt: slaDueAt ? new Date(slaDueAt).toISOString() : null,
    }, etag)
    if (result) onSaved()
  }

  return <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Triagem operacional</h2>
    <fieldset disabled={command.busy || command.uncertain || command.stale} className="grid gap-2">
      <label>Fila<Input value={queue} onChange={event=>setQueue(event.target.value)} maxLength={80}/></label>
      <Lookup endpoint="warranty-staff" label="responsável" compact searchOnly disabled={command.busy} choose={v=>{setAssignedTo(v.id);setName(v.name ?? "")}}/>
      {assignedTo && <div>Responsável • {name || "Funcionário atribuído"} <Button variant="outline" onClick={()=>{setAssignedTo("");setName("")}}>Remover responsável</Button></div>}
      <label>Prazo do SLA<Input type="datetime-local" value={slaDueAt} onChange={event=>setSlaDueAt(event.target.value)}/></label>
    </fieldset>
    {command.stale ? <Button onClick={onSaved}>Atualizar registro</Button> : <Button disabled={command.busy || !queue.trim()} onClick={()=>void save()}>{command.uncertain?"Conferir triagem":"Salvar triagem"}</Button>}
    {command.error && <p role="alert">{command.error}</p>}
  </section>
}
