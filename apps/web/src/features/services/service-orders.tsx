"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { erpFetch } from "@/lib/api/client"
import { apiErrorMessage } from "@/lib/api/error-message"
import { ServiceOrdersList } from "./services-pages"

type Check = { label: string; required: boolean; done: boolean }
type Order = { id: string; number: string; title: string; customerName: string; serialNumber: string | null; technicianName: string | null; status: string; scheduledAt: string | null; slaDueAt: string | null; checklist: Check[]; laborCents: number; partsCents: number; chargeStatus: string; chargeMessage: string | null; underWarranty: boolean; revision: number }
type Detail = Order & { hours: { id: string; minutes: number; note: string }[]; parts: { id: string; productName: string; quantityMicros: string }[]; photos: { id: string; filename: string; caption: string }[] }
type Listing = { tenantId: string; canEdit: boolean; data: Order[]; total: number }
type Customer = { id: string; legalName: string }

const status: Record<string, string> = { open: "Aberta", scheduled: "Agendada", in_progress: "Em execução", completed: "Concluída", cancelled: "Cancelada" }
const charge: Record<string, string> = { none: "—", pending: "Cobrança pendente", blocked: "Cobrança bloqueada", issued: "Cobrança emitida", waived: "Sem cobrança" }
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
const field = "h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
const button = "h-8 rounded-md border border-border bg-card px-3 text-[13px] hover:bg-muted disabled:opacity-50"

async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function ServiceOrders() {
  const [list, setList] = useState<Listing | null>(null), [customers, setCustomers] = useState<Customer[]>([]), [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState(""), [busy, setBusy] = useState(false)
  const keys = useRef(new Map<string, string>())

  const load = useCallback(async () => {
    try {
      const response = await erpFetch("/api/erp/service-orders?limit=50"), value = await response.json()
      if (!response.ok) throw new Error(value.title || "Ordens indisponíveis")
      setList(value)
      const parties = await erpFetch("/api/erp/parties?role=customer&limit=100")
      if (parties.ok) setCustomers((await parties.json()).data ?? [])
    } catch (cause) { setError(apiErrorMessage(cause, "Ordens indisponíveis")) }
  }, [])
  useEffect(() => { let live = true; void Promise.resolve().then(() => live && load()); return () => { live = false } }, [load])
  async function open(id: string) {
    const response = await erpFetch("/api/erp/service-orders/" + id), value = await response.json()
    if (response.ok) setDetail(value.data); else setError(value.title || "Ordem indisponível")
  }
  async function send(path: string, body: unknown, revision?: number, then?: () => Promise<void>) {
    if (!list) return
    setBusy(true); setError("")
    const id = path + JSON.stringify(body).slice(0, 200)
    if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID())
    try {
      const response = await erpFetch("/api/erp/service-orders" + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Id": list.tenantId, "Idempotency-Key": keys.current.get(id)!, ...(revision ? { "If-Match": `"${revision}"` } : {}) }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) throw new Error(value.title || "Operação recusada")
      keys.current.delete(id)
      await load(); await (then ? then() : detail ? open(detail.id) : Promise.resolve())
    } catch (cause) { setError(apiErrorMessage(cause, "Operação recusada")) } finally { setBusy(false) }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget), text = (n: string) => String(form.get(n) ?? "").trim()
    const lines = text("checklist").split("\n").map(l => l.trim()).filter(Boolean)
    await send("", { customerId: text("customerId"), title: text("title"), serialNumber: text("serialNumber") || null, checklist: lines.map(label => ({ label, required: true })) })
  }

  return (
    <div className="workspace-page-frame">
      <PageHeader back={{ href: "/servicos", label: "Serviços" }} eyebrow="Serviços" title="Ordens de serviço" description="Execução em campo: agenda, checklist, horas, peças com baixa de estoque, fotos, assinatura do cliente e cobrança no fechamento." />
      {error && <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">{error}</p>}
      {list?.canEdit && (
        <form onSubmit={create} className="mb-4 grid gap-2 rounded-lg border border-border bg-card p-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <h2 className="text-sm font-semibold sm:col-span-2 lg:col-span-4">Nova ordem</h2>
          <label>Cliente<select required name="customerId" className={field}><option value="">Selecione</option>{customers.map(c => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></label>
          <label>Título<input required minLength={3} name="title" className={field} /></label>
          <label>Série do equipamento<input name="serialNumber" className={field} /></label>
          <div className="flex items-end"><button className={button} disabled={busy} type="submit">Abrir ordem</button></div>
          <label className="sm:col-span-2 lg:col-span-4">Checklist (um item por linha)<textarea name="checklist" rows={2} className={field + " h-auto py-1"} /></label>
        </form>
      )}
      <section className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-3 py-2 text-sm font-semibold">Ordens {list ? `(${list.total})` : ""}</h2>
        {!list ? <p className="p-3 text-[13px] text-muted-foreground">Carregando…</p> : list.data.length === 0 ? <p className="p-3 text-[13px] text-muted-foreground">Nenhuma ordem de serviço aberta.</p> : (
          <ul className="divide-y divide-border text-[13px]">
            {list.data.map(o => (
              <li key={o.id}><button className="grid w-full gap-1 px-3 py-2 text-left hover:bg-muted/40 sm:grid-cols-[100px_minmax(0,1fr)_130px_130px]" onClick={() => void open(o.id)} type="button">
                <strong>{o.number}</strong><span className="min-w-0 truncate">{o.title} · {o.customerName}</span><span>{status[o.status]}</span><span className="text-muted-foreground">{money(o.laborCents + o.partsCents)}</span>
              </button></li>
            ))}
          </ul>
        )}
      </section>
      {detail && list && <OrderPanel busy={busy} canEdit={list.canEdit} detail={detail} send={send} />}
      <h2 className="mb-1 mt-6 text-sm font-semibold">Ordens de garantia</h2>
      <ServiceOrdersList embedded />
    </div>
  )
}

function OrderPanel({ detail, canEdit, busy, send }: { detail: Detail; canEdit: boolean; busy: boolean; send: (path: string, body: unknown, revision?: number) => Promise<void> }) {
  const base = `/${detail.id}`, rev = detail.revision, live = ["open", "scheduled", "in_progress"].includes(detail.status)
  const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false), inked = useRef(false)
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => { const box = event.currentTarget.getBoundingClientRect(); return [(event.clientX - box.left) * event.currentTarget.width / box.width, (event.clientY - box.top) * event.currentTarget.height / box.height] as const }
  function draw(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const context = canvas.current!.getContext("2d")!, [x, y] = point(event)
    context.lineWidth = 2; context.lineCap = "round"; context.lineTo(x, y); context.stroke(); inked.current = true
  }
  async function close(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!inked.current) return alert("Colha a assinatura do cliente")
    const blob = await new Promise<Blob | null>(done => canvas.current!.toBlob(done, "image/png"))
    if (blob) await send(base + "/close", { signerName: String(new FormData(event.currentTarget).get("signer")).trim(), signaturePng: await toBase64(blob) }, rev)
  }
  async function photo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""
    if (file && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) await send(base + "/photos", { filename: file.name, mediaType: file.type, base64: await toBase64(file) }, rev)
  }
  return (
    <section aria-label={detail.number} className="mt-4 grid gap-3 rounded-lg border border-border bg-card p-3 text-[13px]">
      <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{detail.number} · {detail.title}</h2><span>{status[detail.status]} · {charge[detail.chargeStatus]}{detail.underWarranty ? " · garantia" : ""}</span></header>
      <p className="text-muted-foreground">{detail.customerName}{detail.serialNumber ? ` · série ${detail.serialNumber}` : ""}{detail.technicianName ? ` · ${detail.technicianName}` : ""} · mão de obra {money(detail.laborCents)} · peças {money(detail.partsCents)}</p>
      {detail.chargeMessage && <p className="text-muted-foreground">{detail.chargeMessage}</p>}
      {canEdit && ["open", "scheduled"].includes(detail.status) && <button className={button + " w-fit"} disabled={busy} onClick={() => void send(base + "/start", {}, rev)} type="button">Iniciar atendimento</button>}
      {detail.checklist.length > 0 && <fieldset><legend className="font-semibold">Checklist</legend>
        {detail.checklist.map((item, index) => <label className="flex min-h-8 items-center gap-2" key={index}><input checked={item.done} disabled={!canEdit || !live || busy} onChange={e => void send(base + "/checklist", { items: detail.checklist.map((c, i) => i === index ? { ...c, done: e.target.checked } : c) }, rev)} type="checkbox" />{item.label}{item.required ? " *" : ""}</label>)}
      </fieldset>}
      {canEdit && live && (
        <div className="flex flex-wrap items-end gap-2">
          <form className="flex items-end gap-1" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void send(base + "/hours", { minutes: Number(f.get("minutes")), rateCents: Math.round(Number(String(f.get("rate")).replace(",", ".")) * 100) }, rev) }}>
            <label>Minutos<input required type="number" min={1} name="minutes" className={field + " w-20"} /></label>
            <label>R$/hora<input required inputMode="decimal" name="rate" className={field + " w-20"} /></label><button className={button} disabled={busy} type="submit">Lançar horas</button>
          </form>
          <label className={button + " inline-flex cursor-pointer items-center"}>Adicionar foto<input accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={e => void photo(e)} type="file" /></label>
        </div>
      )}
      {detail.hours.length + detail.parts.length + detail.photos.length > 0 && <ul className="text-muted-foreground">
        {detail.hours.map(h => <li key={h.id}>{h.minutes} min {h.note}</li>)}{detail.parts.map(p => <li key={p.id}>{p.productName} × {Number(p.quantityMicros) / 1e6}</li>)}
        {detail.photos.map(p => <li key={p.id}><a className="underline" href={`/api/erp/service-order-photos/${p.id}/file`}>{p.filename}</a></li>)}
      </ul>}
      {canEdit && detail.status === "in_progress" && (
        <form className="grid gap-2" onSubmit={e => void close(e)}>
          <label>Nome de quem assina<input required minLength={3} name="signer" className={field} /></label>
          <canvas aria-label="Assinatura do cliente" className="h-28 w-full touch-none rounded-md border border-border bg-background" height={200} ref={canvas} width={600}
            onPointerDown={e => { drawing.current = true; const c = canvas.current!.getContext("2d")!; const [x, y] = point(e); c.beginPath(); c.moveTo(x, y) }} onPointerMove={draw} onPointerUp={() => { drawing.current = false }} />
          <div className="flex gap-2"><button className={button} disabled={busy} type="submit">Fechar com assinatura</button>
            <button className={button} onClick={() => { canvas.current!.getContext("2d")!.clearRect(0, 0, 600, 200); inked.current = false }} type="button">Limpar</button></div>
        </form>
      )}
      {canEdit && detail.status === "completed" && ["pending", "blocked"].includes(detail.chargeStatus) && <button className={button + " w-fit"} disabled={busy} onClick={() => void send(base + "/charge", {}, rev)} type="button">Repetir cobrança</button>}
    </section>
  )
}
