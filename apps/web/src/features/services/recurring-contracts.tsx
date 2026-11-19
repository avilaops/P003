"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { erpFetch } from "@/lib/api/client"
import { apiErrorMessage } from "@/lib/api/error-message"

type Contract = { id: string; number: string; title: string; customerName: string; status: string; periodicity: string; amountCents: number | string; startOn: string; endOn: string; revision: number }
type Alert = { contractId: string; number: string; customerName: string; kind: string; date: string; overdue: boolean; message: string }
type Customer = { id: string; legalName: string }
type Listing = { tenantId: string; canEdit: boolean; data: Contract[]; total: number }

const periodicity: Record<string, string> = { monthly: "Mensal", quarterly: "Trimestral", semiannual: "Semestral", annual: "Anual" }
const status: Record<string, string> = { draft: "Rascunho", active: "Ativo", suspended: "Suspenso", closed: "Encerrado", cancelled: "Cancelado" }
const money = (cents: number | string) => (Number(cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
const date = (value: string) => value.split("-").reverse().join("/")
const input = "h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
const button = "h-8 rounded-md border border-border bg-card px-3 text-[13px] hover:bg-muted disabled:opacity-50"

export function RecurringContracts() {
  const [list, setList] = useState<Listing | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false)
  const key = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [contracts, warnings] = await Promise.all([erpFetch("/api/erp/service-contracts?limit=50"), erpFetch("/api/erp/service-contracts/alerts")])
      const value = await contracts.json()
      if (!contracts.ok) throw new Error(value.title || "Contratos indisponíveis")
      setList(value); setAlerts(warnings.ok ? (await warnings.json()).data : [])
      const parties = await erpFetch("/api/erp/parties?role=customer&limit=100")
      if (parties.ok) setCustomers((await parties.json()).data ?? [])
    } catch (cause) { setError(apiErrorMessage(cause, "Contratos indisponíveis")) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function send(path: string, body: unknown, revision?: number) {
    if (!list) return
    setBusy(true); setError(""); setMessage("")
    key.current ??= crypto.randomUUID()
    try {
      const response = await erpFetch("/api/erp/service-contracts" + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Id": list.tenantId, "Idempotency-Key": key.current, ...(revision ? { "If-Match": `"${revision}"` } : {}) }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) throw new Error(value.title || "Operação recusada")
      key.current = null; setMessage("Operação concluída."); await load()
    } catch (cause) { setError(apiErrorMessage(cause, "Operação recusada")) }
    finally { setBusy(false) }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget), text = (name: string) => String(form.get(name) ?? "")
    const adjustment = text("adjustmentIndex")
    await send("", {
      customerId: text("customerId"), title: text("title"), periodicity: text("periodicity"), billingDay: Number(text("billingDay")), startOn: text("startOn"), endOn: text("endOn"),
      adjustmentIndex: adjustment, ...(adjustment !== "none" ? { adjustmentBaseOn: text("startOn") } : {}),
      items: [{ description: text("itemDescription"), serviceCode: text("serviceCode"), quantity: text("quantity"), unitCents: Math.round(Number(text("unit").replace(",", ".")) * 100) }],
    })
  }

  return (
    <div className="workspace-page-frame">
      <PageHeader back={{ href: "/servicos/contratos", label: "Contratos" }} eyebrow="Serviços" title="Contratos recorrentes" description="Vigência, itens, reajuste e faturamento automático: o job gera a NFS-e e o título de cada período na data do cronograma." />
      {error && <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{error}</p>}
      {message && <p role="status" className="mb-3 text-[13px] text-muted-foreground">{message}</p>}
      {alerts.length > 0 && (
        <section aria-label="Alertas" className="mb-4 rounded-lg border border-border bg-card">
          <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">Alertas ({alerts.length})</h2>
          <ul className="divide-y divide-border text-[13px]">
            {alerts.map((alert, index) => <li className="flex flex-wrap justify-between gap-2 px-3 py-1.5" key={index}><span><strong>{alert.number}</strong> · {alert.customerName}</span><span className={alert.overdue ? "text-destructive" : "text-muted-foreground"}>{alert.message}</span></li>)}
          </ul>
        </section>
      )}
      {list?.canEdit && (
        <form onSubmit={create} className="mb-4 grid gap-2 rounded-lg border border-border bg-card p-3 text-[13px] sm:grid-cols-3 lg:grid-cols-4">
          <h2 className="text-sm font-semibold sm:col-span-3 lg:col-span-4">Novo contrato</h2>
          <label>Cliente<select required name="customerId" className={input}><option value="">Selecione</option>{customers.map(c => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label>
          <label>Título<input required minLength={3} name="title" className={input} /></label>
          <label>Periodicidade<select name="periodicity" className={input}>{Object.entries(periodicity).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Dia do faturamento<input required type="number" min={1} max={28} defaultValue={5} name="billingDay" className={input} /></label>
          <label>Início<input required type="date" name="startOn" className={input} /></label>
          <label>Fim<input required type="date" name="endOn" className={input} /></label>
          <label>Reajuste<select name="adjustmentIndex" className={input}><option value="none">Sem reajuste</option><option value="ipca">IPCA</option><option value="igpm">IGP-M</option><option value="inpc">INPC</option><option value="fixed">Percentual fixo</option></select></label>
          <label>Item de serviço<input required minLength={2} name="itemDescription" className={input} /></label>
          <label>Código LC 116<input required pattern="[0-9]{2}\.[0-9]{2}" placeholder="14.01" name="serviceCode" className={input} /></label>
          <label>Quantidade<input required defaultValue="1" pattern="[0-9]+(\.[0-9]{1,6})?" name="quantity" className={input} /></label>
          <label>Valor unitário (R$)<input required inputMode="decimal" name="unit" className={input} /></label>
          <div className="flex items-end"><button className={button} disabled={busy} type="submit">Criar contrato</button></div>
        </form>
      )}
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2"><h2 className="text-sm font-semibold">Contratos {list ? `(${list.total})` : ""}</h2>
          {list?.canEdit && <button className={button} disabled={busy} onClick={() => void send("/billing-runs", {})} type="button">Faturar agora</button>}</div>
        {!list ? <p className="p-3 text-[13px] text-muted-foreground">Carregando…</p> : list.data.length === 0 ? <p className="p-3 text-[13px] text-muted-foreground">Nenhum contrato recorrente cadastrado.</p> : (
          <ul className="divide-y divide-border text-[13px]">
            {list.data.map(c => (
              <li className="grid gap-1 px-3 py-2 sm:grid-cols-[110px_minmax(0,1fr)_150px_110px_auto] sm:items-center" key={c.id}>
                <strong>{c.number}</strong>
                <span className="min-w-0 truncate">{c.title} · {c.customerName}</span>
                <span className="text-muted-foreground">{periodicity[c.periodicity]} · {money(c.amountCents)}</span>
                <span>{status[c.status]}</span>
                <span className="flex gap-1">
                  {list.canEdit && c.status === "draft" && <button className={button} disabled={busy} onClick={() => void send(`/${c.id}/transition`, { status: "active" }, c.revision)} type="button">Ativar</button>}
                  {list.canEdit && c.status === "active" && <button className={button} disabled={busy} onClick={() => void send(`/${c.id}/transition`, { status: "suspended" }, c.revision)} type="button">Suspender</button>}
                  {list.canEdit && c.status === "suspended" && <button className={button} disabled={busy} onClick={() => void send(`/${c.id}/transition`, { status: "active" }, c.revision)} type="button">Retomar</button>}
                  <Link className={button + " inline-flex items-center"} href={`/servicos/contratos/recorrentes#${c.id}`}>{date(c.startOn)}–{date(c.endOn)}</Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
