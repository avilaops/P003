"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/workspace/data-table"
import { useCommand, useResource } from "@/hooks/use-operation"
import { AccountSelect, CashNav, Failure, SessionSummary } from "./pos-shared"
import { amount, cents, money, when, type Account, type CashSession, type Envelope, type Listing } from "./pos-model"
import { SessionSales } from "./cash-history"

export function CashClosing() {
  const id = useSearchParams().get("caixa")
  if (!id) return <ChooseCashSession />
  return <SelectedSession key={id} id={id} />
}

function ChooseCashSession() {
  const [offset,setOffset]=useState(0)
  const open=useResource<Listing<CashSession>>(`/api/erp/pos/sessions?status=open&limit=20&offset=${offset}`)
  return <div className="space-y-5"><CashNav /><h2 className="font-semibold">Selecione o caixa para conferência</h2>
    {open.loading ? <p role="status">Consultando caixas abertos…</p> : open.error || !open.value ? <Failure message={open.error || "Caixas indisponíveis"} status={open.status} requestId={open.requestId} retry={open.reload} /> : <>
      {open.value.data.length ? <ul className="divide-y rounded-lg border">{open.value.data.map(s=><li key={s.id}><Link className="block p-3 hover:bg-muted" href={`/vendas/pdv/fechamento?caixa=${s.id}`}><strong>{s.register}</strong><span className="ml-3 text-sm text-muted-foreground">Aberto em {when(s.openedAt)}</span></Link></li>)}</ul> : <p>Nenhum caixa aberto.</p>}
      {open.value.total>20 && <nav aria-label="Paginação dos caixas abertos" className="flex gap-3"><Button variant="outline" disabled={!offset} onClick={()=>setOffset(offset-20)}>Anterior</Button><Button variant="outline" disabled={offset+20>=open.value!.total} onClick={()=>setOffset(offset+20)}>Próxima</Button></nav>}
      <Link className="text-primary underline" href="/vendas/pdv/historico">Consultar fechamentos anteriores</Link>
    </>}
  </div>
}

function SelectedSession({id}:{id:string}) {
  const resource=useResource<Envelope<CashSession>>(`/api/erp/pos/sessions/${encodeURIComponent(id)}`)
  return <div className="space-y-5"><CashNav id={id}/><Link className="inline-flex min-h-11 items-center text-primary underline" href="/vendas/pdv/fechamento">Selecionar outro caixa</Link>
    {resource.loading ? <p role="status">Consultando fechamento…</p> : resource.error || !resource.value ? <Failure message={resource.error || "Caixa indisponível"} status={resource.status} requestId={resource.requestId} retry={resource.reload}/> : <ClosingEditor key={`${resource.value.tenantId}:${resource.value.data.id}:${resource.value.data.revision}`} snapshot={resource.value} reload={resource.reload}/>}
  </div>
}

function MovementReversal({ tenant, session, movementId, reload }: { tenant: string; session: CashSession; movementId: string; reload: () => void }) {
  const [reason, setReason] = useState("")
  const command = useCommand()
  return <details className="mt-2"><summary className="cursor-pointer text-sm text-primary">Estornar movimentação</summary>
    <form className="space-y-2 pt-2" onSubmit={async event => {
      event.preventDefault()
      const saved = await command.send<Envelope<CashSession>>(`/api/erp/pos/sessions/${session.id}/movements`, tenant, { reversesMovementId: movementId, reason: reason.trim() }, `"${session.revision}"`)
      if (saved?.tenantId === tenant && saved.data.id === session.id) reload()
    }}>
      <label>Motivo do estorno<Input required minLength={3} maxLength={200} value={reason} onChange={event => setReason(event.target.value)} disabled={command.busy || command.uncertain || command.stale}/></label>
      {command.error && <Failure message={command.error} status={command.status} retry={command.stale ? reload : undefined}/>}
      <Button type="submit" variant="outline" disabled={command.busy || command.stale}>{command.uncertain ? "Repetir confirmação" : "Confirmar estorno da transferência"}</Button>
    </form></details>
}

function ClosingEditor({ snapshot, reload }: { snapshot: Envelope<CashSession>; reload: () => void }) {
  const [closed, setClosed] = useState<CashSession | null>(null)
  const session = closed || snapshot.data
  const [counted, setCounted] = useState("")
  const [reason, setReason] = useState("")
  const rights = useResource<{ permissions: string[] }>("/api/erp/me")
  const command = useCommand()
  const canClose = snapshot.canClose ?? rights.value?.permissions.includes("sales.pos.close") ?? false
  const countedCents = cents(counted)
  const difference = countedCents == null ? null : countedCents - (cents(session.totals.expectedCash) || 0)
  const frozen = command.busy || command.uncertain || command.stale
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3"><div><h2 className="font-semibold">Caixa {session.register}</h2><p className="mt-1 text-xs text-muted-foreground">Aberto em {when(session.openedAt)}{session.closedAt && ` · Fechado em ${when(session.closedAt)}`}</p></div><span className="rounded-md bg-muted px-2 py-1 text-xs font-medium">{session.status === "closed" ? "Caixa fechado" : "Caixa aberto"}</span></div>
    <SessionSummary session={session} />
    {session.status === "open" && <>
      {snapshot.canEdit && <CashMovement session={session} tenant={snapshot.tenantId} reload={reload} />}
      <form className="max-w-xl space-y-4 rounded-lg border bg-muted/20 p-4" onSubmit={async e => { e.preventDefault(); const value = amount(counted); if (!value || difference !== 0 && reason.trim().length < 3) return; const result = await command.send<Envelope<CashSession>>(`/api/erp/pos/sessions/${session.id}/close`, snapshot.tenantId, { countedCash: value, reason: reason.trim() || null }, `"${session.revision}"`); if (result?.tenantId === snapshot.tenantId && result.data.id === session.id) { setClosed(result.data) } }}>
        <h2 className="font-semibold">Conferência do dinheiro</h2><p>Esperado no caixa • <strong>{money(session.totals.expectedCash)}</strong></p><fieldset disabled={frozen || !canClose} className="space-y-3"><label className="grid gap-1.5 text-xs font-medium">Dinheiro contado (R$)<Input required inputMode="decimal" value={counted} onChange={e => setCounted(e.target.value)} /></label><p role="status" className="text-sm">Diferença: <strong>{money(difference)}</strong></p><label className="grid gap-1.5 text-xs font-medium">Justificativa da diferença<Input required={difference !== null && difference !== 0} minLength={difference !== null && difference !== 0 ? 3 : undefined} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="Obrigatória quando houver diferença" /></label></fieldset>
        <p className="text-xs text-muted-foreground">O fechamento registra o dinheiro contado e a diferença para conferência. Nenhum ajuste de saldo é criado automaticamente.</p>
        {!canClose && <p role="status" className="text-sm">A conclusão exige permissão para fechar o PDV.</p>}
        {command.error && <Failure message={command.error} status={command.status} retry={command.stale ? reload : undefined} />}
        <Button type="submit" disabled={!canClose || command.busy || command.stale}>{command.busy ? "Fechando…" : command.uncertain ? "Conferir fechamento" : "Confirmar fechamento"}</Button>
      </form>
    </>}
    {!!session.movements.length && <section className="space-y-3"><h2 className="font-semibold">Movimentações do caixa</h2><div className="overflow-x-auto rounded-lg border"><DataTable aria-label="Movimentações do caixa"><thead><tr><th>Data</th><th>Tipo e motivo</th><th className="text-right">Valor</th></tr></thead><tbody>{session.movements.map(movement => <tr key={movement.id}><td className="whitespace-nowrap">{when(movement.createdAt)}</td><td>{movement.direction === "supply" ? "Suprimento" : "Sangria"}<span className="block text-xs text-muted-foreground">{movement.reason}</span>{movement.reversesMovementId ? <span className="text-xs">Estorno</span> : movement.reversed ? <span className="text-xs">Movimentação estornada</span> : movement.transferId && session.status === "open" && snapshot.canEdit && <MovementReversal tenant={snapshot.tenantId} session={session} movementId={movement.id} reload={reload} />}</td><td className="whitespace-nowrap text-right">{money(movement.amount)}</td></tr>)}</tbody></DataTable></div></section>}
    <SessionSales id={session.id} tenant={snapshot.tenantId} onChanged={reload} />
  </div>
}

function CashMovement({ session, tenant, reload }: { session: CashSession; tenant: string; reload: () => void }) {
  const accounts = useResource<Listing<Account>>("/api/erp/financial-accounts?status=active&limit=100")
  const [direction, setDirection] = useState("supply")
  const [value, setValue] = useState("")
  const [accountId, setAccountId] = useState("")
  const [reason, setReason] = useState("")
  const command = useCommand()
  const frozen = command.busy || command.uncertain || command.stale
  return <details className="max-w-xl rounded-lg border p-4"><summary className="cursor-pointer text-sm font-semibold">Suprimento ou sangria</summary><form className="mt-4 space-y-3" onSubmit={async e => { e.preventDefault(); const normalized = amount(value); if (!normalized || Number(normalized) <= 0 || accounts.value?.tenantId !== tenant) return; const result = await command.send<Envelope<CashSession>>(`/api/erp/pos/sessions/${session.id}/movements`, tenant, { direction, amount: normalized, reason: reason.trim(), ...(direction === "supply" ? { sourceAccountId: accountId } : { targetAccountId: accountId }) }, `"${session.revision}"`); if (result?.tenantId === tenant && result.data.id === session.id) reload() }}>
    <fieldset disabled={frozen} className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs font-medium">Movimentação<select className="h-9 rounded-lg border bg-background px-3 text-sm" value={direction} onChange={e => setDirection(e.target.value)}><option value="supply">Suprimento · entrada no caixa</option><option value="withdrawal">Sangria · retirada do caixa</option></select></label><label className="grid gap-1.5 text-xs font-medium">Valor da movimentação (R$)<Input required inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} /></label><div className="sm:col-span-2"><AccountSelect label={direction === "supply" ? "Conta de origem do suprimento" : "Conta de destino da sangria"} accounts={accounts.value?.tenantId === tenant ? accounts.value.data : []} omit={session.cashAccountId} value={accountId} onChange={setAccountId} /></div><label className="grid gap-1.5 text-xs font-medium sm:col-span-2">Motivo da movimentação<Input required minLength={3} maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></label></fieldset>
    <p className="text-xs text-muted-foreground">A movimentação transfere saldo entre as contas financeiras selecionadas.</p>
    {(accounts.error || command.error) && <Failure message={accounts.error || command.error} status={command.status} retry={command.stale ? reload : undefined} />}
    <Button type="submit" disabled={command.busy || command.stale || !accountId}>{command.busy ? "Registrando…" : command.uncertain ? "Conferir movimentação" : "Registrar movimentação"}</Button>
  </form></details>
}
