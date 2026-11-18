"use client"

import { useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { GuardedLink, useConfirmNavigation } from "@/components/shell/navigation-guard"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Pagination } from "@/components/workspace/pagination"
import { useResource } from "@/hooks/use-operation"
import { commercialQuantity } from "@/features/sales/order-presentation"
import { historyPath, manualPath, pageOffset, pageSize, stockUrl, textLink, type History, type Movement } from "./stock-model"
import { StockMovementForm } from "./stock-movement-form"

const origins = [
  ["sourceOrderId", "Pedido"], ["sourcePurchaseReceiptId", "Recebimento"], ["productionOrderId", "Ordem de produção"],
  ["sourcePosSaleId", "Venda no PDV"], ["sourceWarrantyCaseId", "Garantia"], ["sourceInventoryCountId", "Inventário"],
  ["returnSourceId", "Origem da devolução"], ["reversesId", "Estorno do movimento"],
] as const

export function StockHistory({ productId, tenant, manual }: { productId: string; tenant: string; manual: boolean }) {
  const path = usePathname(), params = useSearchParams()
  const from = params.get("from") || ""
  const listPath = ["/estoque", "/estoque/saldos", historyPath, manualPath].includes(from) ? from : "/estoque/saldos"
  const listQuery = { tenant, q: params.get("q"), offset: pageOffset(params.get("offset")) }
  const startDate = params.get("startDate") || "", endDate = params.get("endDate") || ""
  const offset = pageOffset(params.get("movementOffset"))
  const query = stockUrl("/api/erp/stock/movements", { productId, startDate, endDate, offset, limit: pageSize })
  const resource = useResource<History>(query)
  const history = resource.value?.tenantId === tenant && resource.value.product?.productId === productId.toLowerCase() ? resource.value : null
  const [reversal, setReversal] = useState<Movement | null>(null), [locked, setLocked] = useState(false)
  const [notice, setNotice] = useState("")
  const confirmNavigation = useConfirmNavigation()
  const details = { ...listQuery, productId, sku: history?.product.sku || "", from: listPath, startDate, endDate, movementOffset: offset }
  const back = stockUrl(listPath, { ...listQuery, focus: productId })
  function filter(startDate: string, endDate: string, movementOffset: number) {
    if (locked || !confirmNavigation()) return
    setReversal(null); setNotice("")
    window.history.pushState(null, "", stockUrl(path, { ...details, startDate, endDate, movementOffset }))
  }
  return <div className="workspace-page-frame">
    <PageHeader title={manual ? "Novo lançamento de estoque" : "Lançamentos de estoque"} back={{ href: back, label: "Voltar à consulta" }} />
    {!history ? resource.loading ? <p role="status">Carregando movimentos…</p> : <div role="alert">
      <p>{resource.error || "O histórico retornou dados diferentes do produto ou da empresa ativa."}</p><Button variant="outline" onClick={resource.reload}>Recarregar histórico</Button>
      {(startDate || endDate) && <GuardedLink className={textLink} href={stockUrl(path, { ...details, startDate: "", endDate: "", movementOffset: 0 })}>Limpar período</GuardedLink>}</div> :
      <section aria-label="Movimentos do produto" className="form-section min-w-0 space-y-4">
        <h2 className="break-words font-semibold">{history.product.name}</h2>
        <p className="break-words">SKU {history.product.sku} • Unidade {history.product.unit}</p>
        {!history.canEdit && <p>Somente consulta. Você não pode movimentar o estoque.</p>}
        {!manual && history.canEdit && <GuardedLink className={textLink} href={stockUrl(manualPath, details)}>Novo lançamento</GuardedLink>}
        {manual && history.canEdit && <StockMovementForm key={reversal?.id || "new"} product={history.product} tenant={tenant} reversal={reversal}
          setLocked={value => { setLocked(value); if (value) setNotice("") }} resetReversal={() => setReversal(null)} confirmed={message => { setNotice(message); resource.reload() }} />}
        {notice && <p role="status">{notice}</p>}
        {manual && <GuardedLink className={textLink} href={stockUrl(historyPath, details)}>Consultar Kardex</GuardedLink>}
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          filter(String(data.get("startDate")), String(data.get("endDate")), 0)
        }} key={startDate + endDate}>
          <label>Data inicial<Input type="date" defaultValue={startDate} name="startDate" disabled={locked} /></label>
          <label>Data final<Input type="date" defaultValue={endDate} name="endDate" disabled={locked} /></label>
          <Button type="submit" variant="outline" disabled={locked}>Aplicar período</Button>
        </form>
        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {([["Saldo inicial", "opening"], ["Entradas", "receipts"], ["Saídas", "issues"], ["Saldo final", "closing"]] as const).map(([label, key]) =>
            <div key={key} className="min-w-0 rounded border p-2"><dt className="text-sm">{label}</dt><dd className="font-medium tabular-nums [overflow-wrap:anywhere]">{commercialQuantity(history.summary[key])} {history.product.unit}</dd></div>)}
        </dl>
        <h3 className="font-medium">Histórico registrado</h3>
        {history.data.length ? <ol className="divide-y border-y">{history.data.map(movement => <li key={movement.id} className="min-w-0 space-y-1 py-3 [overflow-wrap:anywhere]">
          <strong>{movement.direction === "receipt" ? "Entrada" : "Saída"} de {commercialQuantity(movement.quantity)} {history.product.unit}</strong>
          <p>{movement.reason}</p><p>Saldo após o movimento • {commercialQuantity(movement.balanceAfter)} {history.product.unit}</p>
          <time dateTime={movement.occurredAt}>{new Date(movement.occurredAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</time>
          <p className="text-xs text-muted-foreground">ID • {movement.id}</p>
          {origins.map(([key, label]) => movement[key] && <p key={key}>{label} • {movement[key]}</p>)}
          {manual && history.canEdit && movement.canReverse && <Button variant="outline" disabled={locked || history.product.status !== "active"}
            onClick={() => { if (confirmNavigation()) { setReversal(movement); setNotice("") } }}>Preparar estorno de {commercialQuantity(movement.quantity)}</Button>}
        </li>)}</ol> : <p>{history.total ? "Nenhum movimento nesta página." : startDate || endDate ? "Nenhum movimento registrado neste período." : "Nenhum movimento registrado para este produto."}</p>}
        <Pagination offset={offset} total={history.total} loading={locked} pageSize={pageSize} maxOffset={100000} onOffsetChange={value => filter(startDate, endDate, value)} />
      </section>}
  </div>
}
