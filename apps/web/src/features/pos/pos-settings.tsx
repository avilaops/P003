"use client"
import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { useCommand,useResource } from "@/hooks/use-operation"
import { Failure } from "./pos-shared"

type Settings={ tenantId:string; canEdit:boolean; data:{enabled:boolean;revision:number} }
export function PosSettings(){
  const resource=useResource<Settings>("/api/erp/pos/settings")
  return <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
    <PageHeader eyebrow="Preferências • Vendas" title="Frente de caixa" description="Escolha se o PDV aparece no menu da empresa." />
    {resource.loading ? <p role="status">Consultando preferência…</p> : resource.error || !resource.value ? <Failure message={resource.error || "Preferência indisponível"} status={resource.status} retry={resource.reload}/> : <SettingsForm key={resource.value.tenantId+":"+resource.value.data.revision} snapshot={resource.value} reload={resource.reload}/>}
  </main>
}
function SettingsForm({snapshot,reload}:{snapshot:Settings;reload:()=>void}) {
  const command=useCommand(), [enabled,setEnabled]=useState(snapshot.data.enabled)
  return <form className="space-y-4" onSubmit={async e=>{
    e.preventDefault()
    const result=await command.send<Settings>("/api/erp/pos/settings",snapshot.tenantId,{enabled},`"${snapshot.data.revision}"`,"PUT")
    if(result?.tenantId===snapshot.tenantId) {
      window.dispatchEvent(new Event("erp:pos-settings"))
      reload()
    }
  }}>
    <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} disabled={!snapshot.canEdit || command.busy || command.uncertain || command.stale}/> Exibir PDV no menu de Vendas</label>
    {command.error && <Failure message={command.error} status={command.status} retry={command.stale?reload:undefined}/>}
    {snapshot.canEdit ? <Button type="submit" disabled={command.busy || command.stale || !command.uncertain && enabled===snapshot.data.enabled}>{command.uncertain?"Conferir alteração":"Salvar preferência"}</Button> : <p>Somente administradores da empresa podem alterar esta preferência.</p>}
  </form>
}
