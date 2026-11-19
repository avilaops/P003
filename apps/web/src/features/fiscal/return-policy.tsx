"use client"

import {useState} from "react"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {useCommand,useResource} from "@/hooks/use-operation"

type Policy={tenantId:string;revision:number;windowDays:number|null;approvalAboveCents:string|null;canEdit:boolean}
const path="/api/erp/fiscal/return-policy"
export function ReturnPolicy() {
  const read=useResource<Policy>(path),action=useCommand(),[notice,setNotice]=useState("")
  const data=read.value
  return <section id="devolucoes" className="mx-auto max-w-4xl space-y-3 px-4 pb-6"><h2 className="font-semibold">Política de devoluções</h2>
    {read.loading && <p role="status">Consultando a política…</p>}{(read.error || action.error) && <p role="alert">{read.error || action.error}</p>}
    {data && <form key={data.tenantId+":"+data.revision} className="grid max-w-lg gap-3" onSubmit={async e=>{
      e.preventDefault()
      const f=new FormData(e.currentTarget),days=String(f.get("days")||""),amount=String(f.get("amount")||"").replace(",",".")
      const [integer,fraction]=amount.split(".")
      const cents=amount ? (BigInt(integer)*BigInt(100)+BigInt((fraction||"").padEnd(2,"0"))).toString():null
      const saved=await action.send<Policy>(path,data.tenantId,{windowDays:days?Number(days):null,approvalAboveCents:cents},read.etag,"PUT",v=>v.tenantId===data.tenantId)
      if(saved){setNotice("Política salva.");read.reload()}
    }}>
      <label>Prazo em dias corridos após a entrega<Input type="number" min="0" max="3650" name="days" placeholder="Sem prazo máximo" defaultValue={data.windowDays??""} disabled={!data.canEdit || action.busy}/></label>
      <label>Exigir aprovação para valores acima de (R$)<Input inputMode="decimal" pattern="[0-9]{1,13}([,.][0-9]{1,2})?" name="amount" placeholder="Sem alçada por valor" defaultValue={data.approvalAboveCents===null?"":(BigInt(data.approvalAboveCents)/BigInt(100)) +","+ (BigInt(data.approvalAboveCents)%BigInt(100)).toString().padStart(2,"0")} disabled={!data.canEdit || action.busy}/></label>
      <p className="text-sm">O prazo vale no dia da solicitação. Acima do limite, outro aprovador decide no pedido antes da movimentação de estoque e dos títulos.</p>
      {data.canEdit && <Button type="submit" disabled={action.busy || action.stale}>{action.uncertain?"Confirmar a mesma alteração":"Salvar política de devoluções"}</Button>}
      {(action.stale || action.error && !action.uncertain) && <Button type="button" variant="outline" onClick={()=>{action.reset();read.reload()}}>Recarregar política</Button>}
    </form>}{notice && <p role="status">{notice}</p>}
  </section>
}
