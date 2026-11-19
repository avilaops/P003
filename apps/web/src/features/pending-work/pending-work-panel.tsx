"use client"
import Link from "next/link"
import { usePendingWork, type PendingItem } from "./use-pending-work"

const groups: Record<PendingItem["group"], string> = { approvals: "Aprovações", sales: "Vendas", finance: "Financeiro", setup: "Configuração" }
const money = (cents: string | null) => cents == null ? "" : (Number(cents) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })

export function PendingWorkPanel() {
  const result = usePendingWork()
  // Sem permissão para nenhum item (403) o bloco não aparece; erro de rede é mostrado.
  if (result.status === 403) return null
  const data = result.value
  return <section aria-labelledby="pending-work-title" className="rounded-xl border bg-card p-3 text-sm">
    <h2 id="pending-work-title" className="text-sm font-semibold">Precisa da sua atenção</h2>
    {result.loading && !data ? <p role="status" className="mt-2 text-muted-foreground">Consultando pendências…</p>
      : result.error && !data ? <p role="alert" className="mt-2">{result.error}</p>
      : data && !data.items.length ? <p className="mt-2 text-muted-foreground">Nada pendente agora.</p>
      : data && <ul className="mt-2 divide-y">{data.items.map(item => <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
        <span className="w-24 shrink-0 text-xs text-muted-foreground">{groups[item.group]}</span>
        <Link className="min-w-0 flex-1 hover:underline" href={item.href}><strong className="tabular-nums">{item.count}</strong> {item.title}{item.amountCents != null && <span className="text-muted-foreground"> • {money(item.amountCents)}</span>}</Link>
        {item.action && <Link className="text-xs text-primary underline" href={item.action.href}>{item.action.label}</Link>}
      </li>)}</ul>}
  </section>
}
