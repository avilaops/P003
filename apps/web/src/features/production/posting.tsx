"use client"

import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {useCommand} from "@/hooks/use-operation"
import {decimalPattern,normalizeDecimal} from "@/lib/decimal-input"
import {commercialQuantity} from "@/features/sales/order-presentation"
import { useState } from "react"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { useProductionDraftGuard } from "./use-production-draft-guard"

type Planned={productId:string;name:string;sku:string;unit:string;total:string;reserved:string}
type Posting={id:string;produced:string;loss:string;minutes:number;value:string|null;receiptId:string|null;reversed:boolean}
export type ProductionExtension={planned?:Planned[];postings?:Posting[]}
type Props=ProductionExtension&{productId:string;jobId:string;tenant:string;revision:number;open:boolean;canConsume:boolean;version?:number|null;refresh:()=>void;saved:()=>void;onPendingChange:(pending:boolean)=>void}
export function PostingPanel({productId,jobId,tenant,revision,open,canConsume,version,planned=[],postings=[],saved,refresh,onPendingChange}:Props){
  const cmd=useCommand()
  const [dirty, setDirty] = useState(false)
  useProductionDraftGuard(dirty, cmd, "Descartar os dados do apontamento ainda não confirmado?", onPendingChange)
  return <section className="space-y-3 rounded border p-3"><h3 className="font-semibold">Apontamento de produção</h3>
    {version&&<p>Estrutura da ordem • Versão {version}</p>}
    {planned.length>0&&<ul>{planned.map(c=><li key={c.productId}>{c.name} • {c.sku} • Previsto {commercialQuantity(c.total)} {c.unit} • Empenhado {commercialQuantity(c.reserved)} {c.unit}</li>)}</ul>}
    {canConsume&&open&&<form className="space-y-3" onChange={event => {
      const inputs = Array.from(event.currentTarget.elements)
      setDirty(inputs.some(input => input instanceof HTMLInputElement && input.value !== input.defaultValue))
    }} onSubmit={async e=>{
      e.preventDefault()
      const form = e.currentTarget
      const fields=new FormData(form)
      const body={produced:normalizeDecimal(String(fields.get("produced")),6),loss:normalizeDecimal(String(fields.get("loss")),6),
        minutes:Number(fields.get("minutes")),additionalCost:normalizeDecimal(String(fields.get("additionalCost")),2),reason:String(fields.get("reason"))}
      const result=await cmd.send("/api/erp/production/orders/"+jobId+"/postings",tenant,body,'"'+revision+'"',"POST",(r:{tenantId:string;data:{id:string}})=>r.tenantId===tenant&&r.data.id===jobId)
      if(result){form.reset();setDirty(false);saved()}
    }}><fieldset disabled={cmd.busy||cmd.uncertain} className="grid gap-3 sm:grid-cols-2">
      <label>Quantidade produzida<Input name="produced" inputMode="decimal" required pattern={decimalPattern(6)}/></label>
      <label>Perda em unidades<Input name="loss" inputMode="decimal" required defaultValue="0" pattern={decimalPattern(6)}/></label>
      <label>Tempo de produção (min)<Input name="minutes" type="number" min={0} max={5256000} required defaultValue="0"/></label>
      <label>Custos adicionais (R$)<Input name="additionalCost" required inputMode="decimal" defaultValue="0,00" pattern={decimalPattern(2)}/></label>
      <label>Motivo do apontamento<Input name="reason" required minLength={3} maxLength={500}/></label>
    </fieldset><Link className="text-primary underline" href={"/estoque/series?documentId="+jobId+"&productId="+productId+"&tenant="+tenant+"&kind=production"}>Identificar séries produzidas</Link>
      {cmd.error&&<p role="alert">{cmd.error}</p>}{cmd.stale&&<Button type="button" variant="outline" onClick={refresh}>Consultar revisão atual</Button>}
      <Button type="submit" disabled={cmd.stale||cmd.busy}>{cmd.uncertain?"Repetir confirmação":"Confirmar apontamento"}</Button>
    </form>}
    {postings.length>0&&<ul className="space-y-2">{postings.map(p=><li key={p.id}>{p.reversed?"Estornado":"Registrado"} • Produzido {commercialQuantity(p.produced)} • Perda {commercialQuantity(p.loss)} • {p.minutes} min • {p.value===null?"Custo pendente":"Custo R$ "+p.value.replace(".",",")}
      {p.receiptId&&<p><Link className="text-primary underline" href={"/estoque/lancamentos?productId="+productId+"&tenant="+tenant}>Conferir entrada no Kardex</Link></p>}</li>)}</ul>}
  </section>
}
