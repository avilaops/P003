"use client"

import Link from "next/link"
import { RequestError } from "@/components/feedback/session-recovery"
import { Button } from "@/components/ui/button"
import { useResource } from "@/hooks/use-operation"
import { money, purchaseLink } from "./purchase-types"

type Overview = {
  data: {
    openOrders: { count: number; amount: string }
    awaitingApproval: number
    awaitingReceipt: number
    lateReceipts: number
    payableNext7Days: { count: number; amount: string }
    notesWithoutOrder: number
    replenishmentSuggestions: number
  }
}

const link = `${purchaseLink} text-sm`
export function PurchaseOverview() {
  const result = useResource<Overview>("/api/erp/purchase-overview")
  if (result.loading) return <p role="status" className="text-sm">Carregando indicadores…</p>
  if (result.error || !result.value) return <div role="alert" className="text-sm"><p><RequestError message={result.error ?? "Sem dados"} status={result.status} /></p><Button onClick={result.reload}>Tentar novamente</Button></div>
  const d = result.value.data
  const cards: [string, string, string][] = [
    ["Pedidos abertos", String(d.openOrders.count), money(d.openOrders.amount)],
    ["Aguardando recebimento", String(d.awaitingReceipt), d.lateReceipts ? `${d.lateReceipts} atrasado(s)` : "Nenhum atrasado"],
    ["Aguardando aprovação", String(d.awaitingApproval), "Acima da alçada"],
    ["A pagar em 7 dias", money(d.payableNext7Days.amount), `${d.payableNext7Days.count} título(s)`],
  ]
  const actions: [number, string, string][] = [
    [d.lateReceipts, "Compras com previsão de entrega vencida", "/compras/recebimentos"],
    [d.awaitingApproval, "Compras aguardando aprovação", "/compras/pedidos"],
    [d.notesWithoutOrder, "Notas recebidas sem pedido vinculado", "/compras/notas-entrada"],
    [d.replenishmentSuggestions, "Produtos no ponto de pedido", "/compras/sugestoes"],
  ]
  const pending = actions.filter(([n]) => n > 0)
  return <>
    <section aria-label="Indicadores" className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
      {cards.map(([title, value, note]) => <div key={title} className="rounded-md border p-3"><p className="text-xs text-muted-foreground">{title}</p><p className="text-[15px] font-semibold tabular-nums">{value}</p><p className="text-xs text-muted-foreground">{note}</p></div>)}
    </section>
    <section className="form-section mt-4 space-y-2" aria-label="Precisa de ação">
      <h2 className="text-[15px] font-semibold">Precisa de ação</h2>
      {pending.length ? <ul className="space-y-1 text-sm">{pending.map(([n, label, href]) => <li key={href}><Link className={link} href={href}>{n} • {label}</Link></li>)}</ul> : <p className="text-sm text-muted-foreground">Nada pendente.</p>}
    </section>
    <section className="form-section mt-4 flex flex-wrap gap-3 text-sm" aria-label="Atalhos">
      <Link className={link} href="/compras/pedidos/novo">Novo pedido de compra</Link>
      <Link className={link} href="/compras/recebimentos">Registrar recebimento</Link>
      <Link className={link} href="/fiscal/monitor">Importar NF-e de entrada</Link>
      <Link className={link} href="/compras/pedidos">Pedidos de compra</Link>
      <Link className={link} href="/compras/notas-entrada">Notas fiscais de entrada</Link>
      <Link className={link} href="/cadastros/clientes-fornecedores">Fornecedores</Link>
      <Link className={link} href="/financeiro/contas-pagar">Contas a pagar</Link>
    </section>
  </>
}
