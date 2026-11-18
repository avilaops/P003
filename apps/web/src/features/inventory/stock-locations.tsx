"use client"

import Link from "next/link"
import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { useCommand, useResource } from "@/hooks/use-operation"
import { StockTransferForm, TransferList } from "./stock-transfers"
import { selectClass, type LocationSettings } from "./stock-location-model"
import { stockUrl, textLink } from "./stock-model"

const endpoint = "/api/erp/stock/locations"
export function StockLocations({tenant}: {tenant:string}) {
  const settings = useResource<LocationSettings>(endpoint)
  const data = settings.value?.tenantId === tenant ? settings.value : null
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState("")
  function updated(message:string) { setNotice(message); settings.reload(); setRefresh(value=>value+1) }
  return <div className="workspace-page-frame">
    <PageHeader title="Transferências entre depósitos" back={{href:"/estoque/depositos",label:"Depósitos"}} />
    {notice && <p role="status">{notice}</p>}
    {data ? <>
      <section className="form-section space-y-3"><h2 className="font-semibold">Posição por depósito</h2>
        {data.warehouses.length ? <ul className="divide-y">{data.warehouses.map(w=><li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span>{w.code} • {w.name}</span>{data.enabled ?
            <Link className={textLink} href={stockUrl("/estoque/saldos",{tenant,warehouseId:w.id})}>{w.itemsInStock} produto(s) com saldo</Link> :
            <span>{w.itemsInStock} produto(s) com saldo</span>}
        </li>)}</ul> : <p>O depósito Principal será criado ao configurar o estoque ou registrar o primeiro saldo.</p>}
        <Link href="/estoque/depositos" className={textLink}>Consultar cadastro de depósitos</Link>
      </section>
      {data.canEdit && <SettingsForm key={data.revision} config={data} saved={()=>updated("Parâmetros de depósito salvos.")} />}
      {data.enabled && data.canEdit && (data.warehouses.length>=2 ? <StockTransferForm config={data} saved={()=>updated("Transferência registrada.")} /> :
        <p>Cadastre um segundo depósito para transferir produtos.</p>)}
      <TransferList key={refresh} config={data} saved={()=>updated("Transferência estornada.")} />
    </> : settings.loading ? <p role="status">Consultando depósitos…</p> :
      <div role="alert">{settings.error || "Recarregue os depósitos da empresa ativa."} <Button onClick={settings.reload}>Recarregar</Button></div>}
  </div>
}

function SettingsForm({config,saved}:{config:LocationSettings;saved:()=>void}) {
  const command=useCommand(), [enabled,setEnabled]=useState(config.enabled)
  return <form className="form-section space-y-3" onSubmit={async event=>{
    event.preventDefault()
    const fd=new FormData(event.currentTarget)
    const result=await command.send<LocationSettings>(endpoint,config.tenantId,{enabled,revision:config.revision,
      salesId:fd.get("salesId")||null,purchaseId:fd.get("purchaseId")||null,productionId:fd.get("productionId")||null},
    "", "PUT", reply=>reply.tenantId===config.tenantId)
    if(result) saved()
  }}>
    <h2 className="font-semibold">Depósitos padrão</h2>
    <fieldset disabled={command.busy || command.uncertain} className="space-y-3">
      <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)} />Controlar saldos por depósito</label>
      {enabled && <div className="grid gap-3 md:grid-cols-3">{([["salesId","Vendas"],["purchaseId","Compras"],["productionId","Produção"]] as const).map(([key,label])=>
        <label key={key}>{label}<select name={key} className={selectClass} defaultValue={config[key]||""}><option value="">Depósito de abertura</option>
          {config.warehouses.map(w=><option key={w.id} value={w.id}>{w.code} • {w.name}</option>)}</select></label>)}</div>}
    </fieldset>
    {command.error && <p role="alert">{command.error}</p>}
    <Button disabled={command.busy}>{command.uncertain ? "Repetir confirmação" : "Salvar parâmetros"}</Button>
  </form>
}
