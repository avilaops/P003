import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import type { Opportunity } from "./opportunities"
import { pipelineMoney, type StageOption, type SalesMember } from "./opportunity-pipeline-model"

export type StageSummary={stage:string;count:number;estimatedCents:string|number}
export type Conversion={stage:string;reached:number;won:number}
export function PipelineBoard({stages,items,totals,members,selected}:{stages:StageOption[];items:Opportunity[];totals:StageSummary[];members:SalesMember[];selected:string}) {
  const visible=stages.filter(s=>(!selected||s.code===selected) && (s.active||totals.some(t=>t.stage===s.code)))
  return <section aria-label="Quadro de oportunidades por etapa" className="grid min-w-0 gap-3 md:grid-cols-3 xl:grid-cols-4">{visible.map(stage=>{
    const group=items.filter(item=>item.stage===stage.code),total=totals.find(t=>t.stage===stage.code)
    return <section key={stage.code} aria-label={stage.label} className="min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3">
      <h2 className="break-words text-sm font-semibold">{stage.label}{stage.active?"":" • arquivada"}</h2>
      <p className="text-xs text-muted-foreground">{total?.count??0} oportunidades • {pipelineMoney(Number(total?.estimatedCents??0))}</p>
      {group.map(o=><article key={o.id} className="min-w-0 space-y-1 rounded-md border bg-background p-2 text-sm [overflow-wrap:anywhere]">
        <Link className="flex min-h-11 items-center font-medium text-primary underline sm:min-h-9" href={"/vendas/funil/"+o.id}>{o.title}</Link>
        <p>{o.customerName || o.companyName}</p>{o.contactName&&<p>{o.contactName}</p>}
        <p>{pipelineMoney(o.estimatedCents)}</p>{o.ownerId&&<p>{members.find(m=>m.id===o.ownerId)?.name||"Responsável arquivado"}</p>}
      </article>)}
    </section>
  })}</section>
}
export function PipelineConversion({stages,rows}:{stages:StageOption[];rows:Conversion[]}) {
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold">Conversão por etapa</summary>
    <p className="my-2 text-sm">Das oportunidades criadas no período que passaram pela etapa, quantas chegaram a Ganho depois dessa passagem.</p>
    <ul className="grid gap-2 text-sm md:grid-cols-3">{stages.map(s=>{
      const row=rows.find(r=>r.stage===s.code), reached=row?.reached??0,won=row?.won??0
      return <li key={s.code}><strong>{s.label}</strong> • {won} de {reached}{reached?" • "+new Intl.NumberFormat("pt-BR",{style:"percent",maximumFractionDigits:1}).format(won/reached):""}</li>
    })}</ul></details>
}
