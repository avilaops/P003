"use client"

import {Suspense,useState,type FormEvent} from "react"
import Link from "next/link"
import {useSearchParams} from "next/navigation"
import {PageHeader} from "@/components/page-header"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {DataTable} from "@/components/workspace/data-table"
import {RequestError} from "@/components/feedback/session-recovery"
import {useCommand,useResource} from "@/hooks/use-operation"
import {ReportActions,ReportDocument,useReportPreview} from "@/components/documents/report-document"

type Basis="accepted"|"invoiced"
type View="orders"|"goals"|"margins"|"abc"
type Scalar=string|number
type Goal={sellerId:string;seller:string;month:string;line:string;basis:Basis;revision:number;targetCents:string;targetMicros:string;achievedCents:string;achievedMicros:string;achievedBps:number;quantityBps:number;alertBps:number;projectedCents:string|null;alert:boolean}
type Performance={tenantId:string;manage:boolean;sellers:{id:string;name:string}[];channels:string[];
 totals:{orders:number;cancelled:number;orderedCents:string;averageCents:string;invoicedCents:string;returnedCents:string;receivedCents:string|null};
 orders:{id:string;number:string;customer:string;date:string;status:string;createdInPeriod:boolean;channel:string;seller:string|null;cents:string;invoicedCents:string;returnedCents:string;receivedCents:string|null}[];goals:Goal[];
 margins:{id:string;number:string;customer:string;forecastGrossCents:string|null;forecastNetCents:string|null;actualRevenueCents:string|null;actualCostCents:string|null;actualGrossCents:string|null}[]|null;
 abc:{id:string;sku:string;name:string;cents:string;quantityMicros:string;accumulatedBps:number;class:string}[]}
const periods:Record<string,string>={"7D":"Últimos 7 dias","30D":"Últimos 30 dias","3M":"Últimos 3 meses","6M":"Últimos 6 meses","12M":"Últimos 12 meses"}
function periodStart(end:string,range:string){
 const date=new Date(end+"T12:00:00Z"),amount=Number.parseInt(range)
 if(range.endsWith("D"))date.setUTCDate(date.getUTCDate()-amount+1)
 else {const day=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-amount);const lastDay=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,lastDay))}
 return date.toISOString().slice(0,10)
}
const titles={orders:"Pedidos",goals:"Metas por vendedor",margins:"Margem por pedido",abc:"Curva ABC"}
const lineLabels:Record<string,string>={national:"Nacional",imported:"Importada",catalog:"Catálogo"}
const basisLabels={accepted:"Aceite",invoiced:"Faturamento"}
const headers:Record<View,string[]>={orders:["Pedido","Cliente","Criação","Vendedor","Canal","Valor pedido","Faturado","Devolvido","Recebido líquido"],goals:["Vendedor","Mês","Linha","Base","Meta","Realizado","Atingido","Meta em unidades","Unidades","Projeção do mês","Alerta"],margins:["Pedido","Cliente","Margem bruta prevista","Lucro líquido previsto","Receita sem IPI","Custo efetivo","Margem bruta realizada"],abc:["Produto","SKU","Unidades","Valor","Participação acumulada","Classe"]}
const currency=(value:string|null)=> value===null?"Sem base":(Number(value)/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})
const percent=(bps:number)=>(bps/100).toLocaleString("pt-BR",{maximumFractionDigits:2})+"%"
const quantity=(micros:string)=>(Number(micros)/1e6).toLocaleString("pt-BR",{maximumFractionDigits:6})
const dateLabel=(day:string)=>day.split("-").reverse().join("/")
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())
function csvCell(input:Scalar){const value=String(input);return '"'+(/^[=+@\-\t\r]/.test(value)?"'":"")+value.replaceAll('"','""')+'"'}
function csv(title:string,rows:Scalar[][]){
 const href=URL.createObjectURL(new Blob(["\uFEFF"+rows.map(row=>row.map(csvCell).join(";")).join("\r\n")],{type:"text/csv;charset=utf-8"}))
 const link=document.createElement("a");link.href=href;link.download=title+".csv";link.click();setTimeout(()=>URL.revokeObjectURL(href),1000)
}
function goalRows(rows:Goal[]){return rows.map(g=>[g.seller,g.month,lineLabels[g.line],basisLabels[g.basis],currency(g.targetCents),currency(g.achievedCents),percent(g.achievedBps),quantity(g.targetMicros),quantity(g.achievedMicros),currency(g.projectedCents),g.alert?"Abaixo de "+percent(g.alertBps):""])}

export function SalesPerformance({initialView="orders"}:{initialView?:View}) {
 return <Suspense fallback={<p role="status">Carregando relatório…</p>}><Workspace initialView={initialView}/></Suspense>
}
function Workspace({initialView}:{initialView:View}){
 const params=useSearchParams(), todayDate=today(), selection=params.get("view")
 const view:View=selection&&Object.hasOwn(titles,selection)?selection as View:initialView
 const preset=params.get("period")||(params.get("from")?"":initialView==="orders"?"6M":""), origin=params.get("origin")||"ordered"
 const from=params.get("from")||(preset&&periods[preset]?periodStart(todayDate,preset):todayDate.slice(0,7)+"-01"),to=params.get("to")||todayDate,seller=params.get("seller")||"",channel=params.get("channel")||"",basis:Basis=params.get("basis")==="accepted"?"accepted":"invoiced"
 const query=new URLSearchParams({from,to,basis,...(seller?{seller}:{}),...(channel?{channel}:{})})
 const result=useResource<Performance>("/api/erp/commercial/policies/performance?"+query), data=result.value
 const preview=useReportPreview(), [edit,setEdit]=useState<Goal|null>(null),[editing,setEditing]=useState(false)
 function filter(changes:Record<string,string>){
  const url=new URL(window.location.href)
  for(const [key,value] of Object.entries(changes)) if(value)url.searchParams.set(key,value);else url.searchParams.delete(key)
  window.history.pushState(null,"",url);setEditing(false)
 }
 const columns=view==="orders"&&data?.totals.receivedCents===null?headers.orders.slice(0,-1):headers[view]
 const originLink="/relatorios/vendas?"+new URLSearchParams({...Object.fromEntries(query),view,origin,...(preset?{period:preset}:{})})
 const orderOrigins=(data?.orders??[]).filter(o=>origin==="all"|| (origin==="invoiced"?BigInt(o.invoicedCents)!==BigInt(0):origin==="returned"?BigInt(o.returnedCents)!==BigInt(0):origin==="received"?o.receivedCents!==null&&BigInt(o.receivedCents)!==BigInt(0):o.createdInPeriod&&(origin==="cancelled"?o.status==="cancelled":o.status!=="cancelled")))
 const series=new Map<string,{count:number;cents:bigint}>()
 for(const o of data?.orders??[])if(o.createdInPeriod&&o.status!=="cancelled"){
  const month=o.date.slice(0,7),value=series.get(month)??{count:0,cents:BigInt(0)}
  series.set(month,{count:value.count+1,cents:value.cents+BigInt(o.cents)})
 }
 const rows:Scalar[][]=!data?[]:view==="orders"?orderOrigins.map(o=>[o.number,o.customer,dateLabel(o.date),o.seller||"Sem vendedor",o.channel,currency(o.cents),currency(o.invoicedCents),currency(o.returnedCents),...(data.totals.receivedCents===null?[]:[currency(o.receivedCents)])]):view==="goals"?goalRows(data.goals):view==="margins"?(data.margins??[]).map(m=>[m.number,m.customer,currency(m.forecastGrossCents),currency(m.forecastNetCents),currency(m.actualRevenueCents),currency(m.actualCostCents),currency(m.actualGrossCents)]):data.abc.map(p=>[p.name,p.sku,quantity(p.quantityMicros),currency(p.cents),percent(p.accumulatedBps),p.class])
 const metrics:[string,string][] = !data?[]:[["Pedidos",String(data.totals.orders)],["Valor pedido",currency(data.totals.orderedCents)],["Ticket médio",currency(data.totals.averageCents)],["Pedidos cancelados",String(data.totals.cancelled)],["Faturado em produção",currency(data.totals.invoicedCents)],["Devoluções",currency(data.totals.returnedCents)],...(data.totals.receivedCents===null?[]:[["Recebido líquido",currency(data.totals.receivedCents)] as [string,string]])]
 const scope=view==="orders"?"Pedidos por criação. Faturamento por emissão autorizada de produção. Recebimentos por data de pagamento, líquidos de estornos.":view==="goals"?"Metas de meses completos. A projeção usa os dias corridos já transcorridos.":view==="margins"?"Previsão congelada no aceite. A margem bruta realizada usa a receita das mercadorias sem IPI e o custo médio ponderado das compras recebidas até a emissão, com devoluções no período.":"Produtos por valor líquido da base selecionada. As classes A e B abrangem até os produtos que atingem os cortes de 80% e 95%."
 const sectionAvailable=!(view==="margins"&&data?.margins===null)
 return <main className="mx-auto max-w-7xl space-y-5 p-4" data-report-workspace><PageHeader title="Relatório de vendas" breadcrumbs={[{label:"Relatórios",href:"/relatorios"},{label:"Vendas"}]}/>
 <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1">Período<select className="h-10 rounded border bg-background" value={preset} onChange={e=>{const p=e.target.value;filter({period:p,from:p?periodStart(todayDate,p):from,to:p?todayDate:to})}}><option value="">Personalizado</option>{Object.entries(periods).map(([p,name])=><option key={p} value={p}>{name}</option>)}</select></label><label className="grid gap-1">De<Input type="date" value={from} max={to} onChange={e=>filter({from:e.target.value,period:""})}/></label><label className="grid gap-1">Até<Input type="date" min={from} value={to} onChange={e=>filter({to:e.target.value,period:""})}/></label>
 <label className="grid gap-1">Vendedor<select className="h-10 rounded border bg-background" value={seller} onChange={e=>filter({seller:e.target.value})}><option value="">Todos</option>{data?.sellers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
 <label className="grid gap-1">Canal<select className="h-10 rounded border bg-background" value={channel} onChange={e=>filter({channel:e.target.value})}><option value="">Todos</option>{data?.channels.map(c=><option key={c}>{c}</option>)}</select></label>
 <Button variant="outline" onClick={result.reload}>Atualizar</Button></div>
 {result.loading?<p role="status">Consultando vendas…</p>:result.error?<RequestError message={result.error} status={result.status}/>:data&&<>
 <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">{metrics.map(([label,value])=><div className="rounded-lg border p-3" key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>)}</dl>
 <nav className="flex flex-wrap gap-2" aria-label="Análises de vendas">{(Object.keys(titles) as View[]).filter(v=>v!=="margins"||data.margins!==null).map(v=><Button key={v} aria-pressed={v===view} variant={v===view?"default":"outline"} onClick={()=>{filter({view:v});setEditing(false)}}>{titles[v]}</Button>)}</nav>
 {sectionAvailable?<section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{titles[view]}</h2><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>csv("vendas-"+view+"-"+from+"-"+to,[["De",from,"Até",to,"Canal",channel||"Todos","Vendedor",data.sellers.find(s=>s.id===seller)?.name||"Todos"],...metrics,[],columns,...rows])}>Exportar CSV</Button><ReportActions disabled={!data} open={preview.open} onToggle={preview.toggle}/>{view==="goals"&&data.manage&&<Button onClick={()=>{setEdit(null);setEditing(true)}}>Cadastrar meta</Button>}</div></div><p className="text-sm text-muted-foreground">{scope}</p>
 {view==="orders"&&<><label>Registros de origem <select value={origin} onChange={e=>filter({origin:e.target.value})}><option value="ordered">Pedidos criados válidos</option><option value="invoiced">Faturamento no período</option><option value="returned">Devoluções no período</option>{data.totals.receivedCents!==null&&<option value="received">Recebimentos no período</option>}<option value="cancelled">Pedidos cancelados por criação</option><option value="all">Todas as origens</option></select></label>
 {series.size>0&&<details><summary>Pedidos por mês de criação</summary><ul>{[...series.entries()].sort().map(([m,v])=><li key={m}>{m.slice(5)+"/"+m.slice(0,4)} • {v.count} pedidos • {currency(v.cents.toString())}</li>)}</ul></details>}</>}
 {view==="abc"&&<label>Base da curva <select value={basis} onChange={e=>filter({basis:e.target.value})}><option value="invoiced">Faturado líquido de devoluções</option><option value="accepted">Pedidos aceitos</option></select></label>}
 {view==="goals"&&editing&&<GoalForm key={edit?edit.sellerId+edit.month+edit.line:"new"} data={data} initial={edit} month={from.slice(0,7)} onSaved={()=>{setEditing(false);result.reload()}}/>}
 {rows.length?<div className="overflow-x-auto"><DataTable aria-label={titles[view]}><thead><tr>{columns.map(h=><th key={h}>{h}</th>)}{view==="goals"&&data.manage&&<th>Editar</th>}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{row.map((v,j)=><td key={j}>{j===0&&(view==="orders"||view==="margins")?<Link className="underline" href={"/vendas/pedidos/"+(view==="orders"?orderOrigins[i].id:data.margins![i].id)+"?relatorio="+encodeURIComponent(originLink)}>{v}</Link>:v}</td>)}{view==="goals"&&data.manage&&<td><Button variant="outline" onClick={()=>{setEdit(data.goals[i]);setEditing(true)}}>Editar</Button></td>}</tr>)}</tbody></DataTable></div>:<p>Nenhum registro neste período e filtros.</p>}
 {preview.open&&<ReportDocument tenantId={data.tenantId} title={titles[view]} period={dateLabel(from)+" a "+dateLabel(to)} scope={scope} note={[channel||"Todos os canais",data.sellers.find(s=>s.id===seller)?.name||"Todos os vendedores"].join(" • ")} metrics={metrics} columns={columns} rows={rows.map(r=>r.map(String))}/>}</section>:<p>Seu perfil permite consultar os demais indicadores comerciais.</p>}</>}</main>
}
function GoalForm({data,initial,month,onSaved}:{data:Performance;initial:Goal|null;month:string;onSaved:()=>void}){
 const command=useCommand(),[error,setError]=useState("")
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();const form=new FormData(e.currentTarget),v=(key:string)=>String(form.get(key)??"")
  const amt=v("amount").replace(",","."),qty=v("quantity").replace(",","."), alert=v("alert").replace(",",".")
  if(!/^\d+(?:\.\d{1,2})?$/.test(amt)||!/^\d+(?:\.\d{1,6})?$/.test(qty)||!/^\d+(?:\.\d{1,2})?$/.test(alert)){setError("Confira valor, quantidade e percentual.");return}
  const micros=BigInt(qty.split(".")[0])*BigInt(1000000)+BigInt((qty.split(".")[1]||"").padEnd(6,"0"))
  const body={sellerId:initial?.sellerId||v("seller"),month:initial?.month||v("month"),line:initial?.line||v("line"),basis:v("basis"),targetCents:Math.round(Number(amt)*100),targetMicros:micros.toString(),alertBps:Math.round(Number(alert)*100),revision:initial?.revision||0}
  if(await command.send("/api/erp/commercial/policies/goals",data.tenantId,body))onSaved()
 }
 return <form onSubmit={submit} className="rounded-lg border p-3"><fieldset disabled={command.busy||command.uncertain} className="grid gap-3 sm:grid-cols-3">
 <label>Vendedor <select name="seller" required disabled={!!initial} defaultValue={initial?.sellerId||""}><option value="">Selecione</option>{data.sellers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
 <label>Competência <Input name="month" type="month" required disabled={!!initial} defaultValue={initial?.month||month}/></label>
 <label>Linha <select name="line" defaultValue={initial?.line||"national"} disabled={!!initial}>{Object.entries(lineLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Base <select name="basis" defaultValue={initial?.basis||"accepted"}><option value="accepted">Aceite</option><option value="invoiced">Faturamento</option></select></label>
 <label>Meta em reais<Input name="amount" inputMode="decimal" required defaultValue={initial?Number(initial.targetCents)/100:""}/></label>
 <label>Meta em unidades<Input name="quantity" inputMode="decimal" required defaultValue={initial?Number(initial.targetMicros)/1e6:""}/></label>
 <label>Alerta abaixo de (%)<Input name="alert" inputMode="decimal" required defaultValue={(initial?.alertBps??8000)/100}/></label></fieldset>
 <Button className="mt-3" type="submit" disabled={command.busy||command.stale}>{command.uncertain?"Conferir gravação":"Salvar meta"}</Button>{(command.error||error)&&<p role="alert">{command.error||error}</p>}</form>
}
