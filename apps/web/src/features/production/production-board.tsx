"use client"

import Link from "next/link"
import {Button} from "@/components/ui/button"
import { DataTable } from "@/components/workspace/data-table"
import {commercialQuantity} from "@/features/sales/order-presentation"
export type Job={id:string;orderId:string;productId:string;sku:string;name:string;unit:string;quantity:string;stageId:string;stageName:string;
  stageKind:string;status:string;revision:number;customer?:string;orderNumber?:string;plannedOn?:string|null;overdue?:boolean;daysInStage?:number;bomVersion?:number|null}
export type Stage={id:string;name:string;kind:string;position:number;revision:number}
type MoveJob = (job: Job, stage: string) => void
export type ProductionView = "list" | "board"
type BoardProps = {
  jobs: Job[]
  stages: Stage[]
  locked: boolean
  choose: (job: Job) => void
  move?: MoveJob
  view: ProductionView
  setView: (view: ProductionView) => void
}

function StageAction({ job, stages, locked, move }: { job: Job; stages: Stage[]; locked: boolean; move: MoveJob }) {
  return <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
    event.preventDefault()
    const stage = String(new FormData(event.currentTarget).get("stage") || "")
    if (stage) move(job, stage)
  }}>
    <label className="min-w-0">Etapa de {job.sku}
      <select name="stage" className="block min-h-9 max-w-full rounded border" defaultValue="" required disabled={locked}>
        <option value="">Selecione</option>
        {stages.filter(stage => stage.id !== job.stageId && (!job.bomVersion || stage.kind !== "pronta"))
          .map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
      </select>
    </label>
    <Button type="submit" variant="outline" disabled={locked}>Mover {job.sku}</Button>
  </form>
}

export function ProductionBoard({ jobs, stages, locked, choose, move, view, setView }: BoardProps) {
  const groups=stages.map(s=>({...s,jobs:jobs.filter(j=>j.stageId===s.id)}))
  const order = (job: Job) => <Link className="break-all text-primary underline" href={"/vendas/pedidos/" + job.orderId}>Pedido {job.orderNumber || job.orderId}</Link>
  const product = (job: Job) => <button type="button" className="break-words text-left font-medium text-primary underline" disabled={locked} onClick={() => choose(job)}>Consultar {job.name}</button>
  const deadline = (job: Job) => job.plannedOn && <span className={job.overdue ? "block font-medium text-destructive" : "block"}>
    {job.overdue ? "Prazo vencido" : "Prazo"} • {job.plannedOn.split("-").reverse().join("/")}
  </span>
  return <div className="space-y-3"><label>Visualização<select className="ml-2 rounded border p-2" value={view} onChange={e=>setView(e.target.value === "board" ? "board" : "list")}>
    <option value="list">Lista</option><option value="board">Quadro por etapa</option></select></label>
    {view === "list" ? <DataTable aria-label="Ordens de produção" className="table-fixed [overflow-wrap:anywhere] [&_td]:px-2 [&_th]:px-2">
      <thead><tr><th scope="col" className="hidden md:table-cell">Pedido de origem</th><th scope="col">Produto</th>
        <th scope="col" className="w-1/4 text-right md:w-auto">Quantidade</th><th scope="col">Etapa</th></tr></thead>
      <tbody>{jobs.map(job => <tr key={job.id}>
        <td className="hidden md:table-cell">{order(job)}<span className="block text-xs">{job.customer}</span></td>
        <th scope="row">{product(job)}<span className="block text-xs font-normal">{job.sku}</span>
          <span className="block text-xs font-normal md:hidden">{order(job)}{job.customer && <span className="block">{job.customer}</span>}</span></th>
        <td className="text-right tabular-nums">{commercialQuantity(job.quantity)} {job.unit}</td>
        <td>{job.stageName}{job.status === "cancelled" && <span className="block">Cancelada</span>}
          <div className="text-xs">{job.daysInStage !== undefined && <span>{job.daysInStage} dias na etapa</span>}{deadline(job)}</div>
          {move && job.status !== "cancelled" && <details className="mt-1"><summary className="cursor-pointer text-xs font-medium">Alterar etapa</summary>
            <StageAction job={job} stages={stages} locked={locked} move={move} /></details>}</td>
      </tr>)}</tbody>
    </DataTable> : <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">{groups.map(group=><section key={group.id} className="min-w-0 space-y-2 rounded border p-3">
      <h3 className="font-medium">{group.name} • {group.jobs.length}</h3>
      <ul className="space-y-2">{group.jobs.map(j=><li key={j.id} className="min-w-0 rounded border p-3">
        {product(j)}<p>{commercialQuantity(j.quantity)} {j.unit} • {j.sku}</p><p>{j.customer}</p>{order(j)}
        <p>{j.stageName}{j.daysInStage!==undefined&&" • "+j.daysInStage+" dias na etapa"}</p>{deadline(j)}
        {j.status==="cancelled"&&<p>Cancelada</p>}
        {move&&j.status!=="cancelled"&&<StageAction job={j} stages={stages} locked={locked} move={move} />}
      </li>)}</ul></section>)}</div>}</div>
}
