"use client"

import {useState,type FormEvent} from "react"
import {Input} from "@/components/ui/input"
import {Button} from "@/components/ui/button"
import {GuardedLink as Link} from "@/components/shell/navigation-guard"
import {useCommand,useResource} from "@/hooks/use-operation"

type Account={id:string;code:string;name:string;classification:string}
type Config={tenantId:string;canEdit:boolean;data:{revision:number};accounts:Account[];
  rules:{eventType:string;debitId:string;creditId:string}[];periods:{month:string;closed:boolean;reason:string}[];
  pending:{eventType:string;count:number}[];pendingInvoices:number;eventTypes:string[]}
const select="block h-9 w-full rounded-lg border bg-background px-2 text-sm"
const classes={asset:"Ativo",liability:"Passivo",equity:"Patrimônio líquido",revenue:"Receita",expense:"Despesa"}
const events:Record<string,string>={"sale.invoice":"Venda faturada","purchase.receipt":"Entrada de compra","commission.closing":"Fechamento de comissão","manual.reversal":"Estorno contábil"}
const parts:Record<string,string>={cash:"principal em caixa",non_cash:"principal sem caixa",interest:"juros",penalty:"multa",surcharge:"acréscimo",discount:"desconto"}
function label(type:string):string {
  if(type.endsWith(".reversal") && type!=="manual.reversal") return "Estorno • "+label(type.slice(0,-9))
  if(events[type]) return events[type]
  const [side,part]=type.split(".")
  return (side==="receivable"?"Recebimento":"Pagamento")+" • "+(parts[part] ?? part)
}
function source(type:string,id:string) {
  const paths:Record<string,string>={order:"/vendas/pedidos/",purchase:"/compras/pedidos/",receivable:"/financeiro/contas-receber/",payable:"/financeiro/contas-pagar/"}
  return paths[type]?paths[type]+id:null
}
function currentMonth() {
  const now=new Date()
  return now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")
}
export function AccountingWorkspace() {
  const config=useResource<Config>("/api/erp/accounting")
  if(config.loading && !config.value) return <p role="status">Consultando contabilidade…</p>
  if(!config.value) return <p role="alert">{config.error} <Button onClick={config.reload}>Consultar novamente</Button></p>
  return <AccountingForms key={config.value.tenantId} config={config.value} etag={config.etag} refresh={config.reload}/>
}
function AccountingForms({config,etag,refresh}:{config:Config;etag:string;refresh:()=>void}) {
  const [period,setPeriod]=useState(currentMonth),[filterAccount,setFilterAccount]=useState(""),[report,setReport]=useState("journal")
  const [action,setAction]=useState("accounts"),[entry,setEntry]=useState(""),[notice,setNotice]=useState("")
  const command=useCommand()
  const first=period+"-01",last=period?new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10):""
  const base="/api/erp/accounting/reports/"+report+"?from="+first+"&to="+last+(filterAccount?"&accountId="+filterAccount:"")
  const result=useResource<{tenantId:string;data:Record<string,string>[] }>(base)
  const options=config.accounts.map(a=><option key={a.id} value={a.id}>{a.code} • {a.name}</option>)
  const byId=(id:string)=>config.accounts.find(a=>a.id===id)?.code
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const values=Object.fromEntries(new FormData(e.currentTarget)),url="/api/erp/accounting/"+(action==="reverse"?"entries/"+entry+"/reverse":action)
    const saved=await command.send<Config>(url,config.tenantId,values,etag)
    if(saved){setNotice("Operação registrada.");refresh();result.reload()}
  }
  return <div className="space-y-5">
    <section className="form-section space-y-3"><h2 className="font-semibold">Plano de contas e regras</h2>
      {config.accounts.length===0?<p>Nenhuma conta cadastrada.</p>:<ul>{config.accounts.map(a=><li key={a.id}>{a.code} • {a.name} • {classes[a.classification as keyof typeof classes]}</li>)}</ul>}
      {config.rules.length>0 && <ul>{config.rules.map(r=><li key={r.eventType}>{label(r.eventType)} • Débito {byId(r.debitId)} • Crédito {byId(r.creditId)}</li>)}</ul>}
      {config.pending.map(p=><p key={p.eventType}>{p.count} pendente(s) • {label(p.eventType)}</p>)}
      {config.pendingInvoices>0 && <p>{config.pendingInvoices} evento(s) fiscal(is) aguardam sincronização.</p>}
      {config.canEdit && <form className="space-y-3" onSubmit={submit}>
        <fieldset disabled={command.busy||command.uncertain||command.stale} className="grid gap-3 sm:grid-cols-2">
          <label>Operação contábil<select value={action} className={select} onChange={e=>{setAction(e.target.value);setNotice("");command.reset()}}>
            <option value="accounts">Cadastrar conta</option><option value="rules">Configurar regra de contabilização</option><option value="sync">Contabilizar eventos pendentes</option>
            <option value="close">Encerrar competência</option><option value="reopen">Reabrir competência</option>{entry && <option value="reverse">Estornar lançamento selecionado</option>}
          </select></label>
          {action==="accounts" && <><label>Código da conta<Input name="code" required maxLength={40}/></label><label>Nome da conta<Input name="name" required minLength={2}/></label><label>Classificação<select name="classification" className={select}>{Object.entries(classes).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label></>}
          {action==="rules" && <><label>Evento<select name="eventType" className={select}>{config.eventTypes.map(t=><option key={t} value={t}>{label(t)}</option>)}</select></label>
          <label>Conta de débito<select required name="debitId" className={select}><option value="">Selecione a conta</option>{options}</select></label>
          <label>Conta de crédito<select required name="creditId" className={select}><option value="">Selecione a conta</option>{options}</select></label></>}
          {(action==="close"||action==="reopen") && <label>Competência da operação<Input required name="month" type="month" defaultValue={period}/></label>}
          {action==="reverse" && <><p>Lançamento selecionado • {entry}</p><label>Data do estorno<Input name="occurredOn" type="date" required/></label></>}
          {["close","reopen","reverse"].includes(action) && <label>Justificativa<Input required name="reason" minLength={3} maxLength={200}/></label>}
        </fieldset>
        {command.error && <p role="alert">{command.error}</p>}{notice && <p role="status">{notice}</p>}
        {command.stale && <Button type="button" variant="outline" onClick={refresh}>Recarregar contabilidade</Button>}
        <Button disabled={command.busy||command.stale}>{command.uncertain?"Repetir confirmação":"Confirmar operação"}</Button>
      </form>}
      {config.periods.length>0 && <ul>{config.periods.map(p=><li key={p.month}>{p.month} • {p.closed?"Encerrada":"Reaberta"} • {p.reason}</li>)}</ul>}
    </section>
    <section className="form-section space-y-4"><h2 className="font-semibold">Livros contábeis</h2>
      <div className="grid gap-3 sm:grid-cols-3"><label>Livro<select className={select} value={report} onChange={e=>setReport(e.target.value)}><option value="journal">Diário</option><option value="ledger">Razão</option><option value="trial-balance">Balancete</option></select></label>
      <label>Mês dos lançamentos<Input type="month" value={period} min="1900-01" max="2100-12" onChange={e=>{if(e.target.value)setPeriod(e.target.value)}}/></label>
      <label>Conta<select className={select} value={filterAccount} onChange={e=>setFilterAccount(e.target.value)}><option value="">Todas as contas</option>{options}</select></label></div>
      <a className="font-medium text-primary underline" href={base+"&format=csv"} download>Exportar livro em CSV</a>
      {result.loading?<p>Consultando lançamentos…</p>:result.error?<p role="alert">{result.error}</p>:result.value?.data.length===0?<p>Nenhum lançamento neste período.</p>:<ul className="space-y-2">{result.value?.data.map((r,i)=><li key={(r.id??r.account)+"-"+i} className="rounded-lg border p-3">
        {report==="journal"?<><p>{r.date} • {label(r.eventType)} • R$ {r.amount}</p><p>Débito {r.debitAccount} {r.debitName} • Crédito {r.creditAccount} {r.creditName}</p></>:<><p>{r.account} • {r.name??r.date}</p>
        <p>Saldo anterior R$ {r.opening} • Débito R$ {r.debit} • Crédito R$ {r.credit} • Saldo R$ {r.balance}</p></>}
        {source(r.documentType,r.documentId) && <Link className="mr-3 font-medium text-primary underline" href={source(r.documentType,r.documentId)!}>Abrir documento de origem</Link>}
        {report==="journal" && config.canEdit && !r.reversesEntryId && <Button variant="outline" onClick={()=>{setEntry(r.id);setAction("reverse");setNotice("");window.scrollTo({top:0,behavior:"smooth"})}}>Selecionar para estorno</Button>}
      </li>)}</ul>}
    </section></div>
}
