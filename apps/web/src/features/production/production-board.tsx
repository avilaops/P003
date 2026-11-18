"use client"

import {useState} from "react"
import Link from "next/link"
import {Button} from "@/components/ui/button"
import {commercialQuantity} from "@/features/sales/order-presentation"
export type Job={id:string;orderId:string;productId:string;sku:string;name:string;unit:string;quantity:string;stageId:string;stageName:string;
  stageKind:string;status:string;revision:number;customer?:string;orderNumber?:string;plannedOn?:string|null;overdue?:boolean;daysInStage?:number;bomVersion?:number|null}
export type Stage={id:string;name:string;kind:string;position:number;revision:number}
export function ProductionBoard({jobs,stages,locked,choose,move}:{jobs:Job[];stages:Stage[];locked:boolean;choose:(j:Job)=>void;move?:((j:Job,s:string)=>void)|undefined}){
  const [view,setView]=useState("board")
  const groups=view==="list"?[{id:"all",name:"Todas as etapas",jobs}]:stages.map(s=>({...s,jobs:jobs.filter(j=>j.stageId===s.id)}))
  return <div className="space-y-3"><label>Visualização<select className="ml-2 rounded border p-2" value={view} onChange={e=>setView(e.target.value)}>
    <option value="board">Quadro por etapa</option><option value="list">Lista</option></select></label>
    <div className={view==="list"?"space-y-2":"grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3"}>{groups.map(group=><section key={group.id} className="min-w-0 space-y-2 rounded border p-3">
      <h3 className="font-medium">{group.name} • {group.jobs.length}</h3>
      <ul className="space-y-2">{group.jobs.map(j=><li key={j.id} className="min-w-0 rounded border p-3">
        <button type="button" className="break-words text-left font-medium text-primary underline" disabled={locked} onClick={()=>choose(j)}>Consultar {j.name}</button>
        <p>{commercialQuantity(j.quantity)} {j.unit} • {j.sku}</p><p>{j.customer}</p><Link className="break-all text-primary underline" href={"/vendas/pedidos/"+j.orderId}>Pedido {j.orderNumber||j.orderId}</Link>
        <p>{j.stageName}{j.daysInStage!==undefined&&" • "+j.daysInStage+" dias na etapa"}</p>{j.plannedOn&&<p className={j.overdue?"font-medium text-destructive":""}>{j.overdue?"Prazo vencido":"Prazo"} • {j.plannedOn.split("-").reverse().join("/")}</p>}
        {j.status==="cancelled"&&<p>Cancelada</p>}
        {move&&j.status!=="cancelled"&&<form onSubmit={e=>{e.preventDefault();const s=String(new FormData(e.currentTarget).get("stage")||"");if(s)move(j,s)}}>
          <label>Etapa de {j.sku}<select name="stage" className="min-h-10 max-w-full rounded border" defaultValue="" required disabled={locked}>
            <option value="">Selecione</option>{stages.filter(s=>s.id!==j.stageId&&(!j.bomVersion||s.kind!=="pronta")).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <Button type="submit" variant="outline" disabled={locked}>Mover {j.sku}</Button></form>}
      </li>)}</ul></section>)}</div></div>
}
