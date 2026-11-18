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
import { historyPath, manualPath, movementLedgerReturn, pageOffset, pageSize, stockUrl, textLink, type History, type Movement } from "./stock-model"
import { StockMovementForm } from "./stock-movement-form"
import { StockAnalysisLink } from "./stock-analysis-link"
import { stockMoney } from "./stock-model"

const origins = [
  ["sourceOrderId", "Pedido", "/vendas/pedidos/"], ["sourcePurchaseReceiptId", "Recebimento", "/compras/recebimentos/"],
  ["productionOrderId", "Ordem de produção", "/estoque/ordens-producao/"], ["sourcePosSaleId", "Venda no PDV", "/vendas/pdv/historico?venda="],
  ["sourceWarrantyCaseId", "Garantia", "/vendas/garantias/"], ["sourceInventoryCountId", "Inventário", "/estoque/inventarios/"],
] as const

export function StockHistory({ productId, tenant, manual }: { productId: string; tenant: string; manual: boolean }) {
  const path = usePathname(), params = useSearchParams()
  const from = params.get("from") || ""
  const listPath = ["/estoque", "/estoque/saldos", historyPath, manualPath].includes(from) ? from : "/estoque/saldos"
  const warehouseId = params.get("warehouseId")
  const originalWarehouse = params.get("fromWarehouseId") || warehouseId
  const listQuery = { tenant, q: params.get("q"), offset: pageOffset(params.get("offset")), warehouseId: originalWarehouse === "all" ? null : originalWarehouse, inStock:params.get("inStock") }
  const startDate = params.get("startDate") || "", endDate = params.get("endDate") || ""
  const offset = pageOffset(params.get("movementOffset"))
  const direction = params.get("direction") || "", orderOffset = pageOffset(params.get("orderOffset"))
  const query = stockUrl("/api/erp/stock/movements", { productId, startDate, endDate, offset, limit: pageSize, warehouseId, direction, orderOffset })
  const resource = useResource<History>(query)
  const history = resource.value?.tenantId === tenant && resource.value.product?.productId === productId.toLowerCase() ? resource.value : null
  const [reversal, setReversal] = useState<Movement | null>(null), [locked, setLocked] = useState(false)
  const [notice, setNotice] = useState("")
  const confirmNavigation = useConfirmNavigation()
  const returnQuery = movementLedgerReturn(params.get("returnQuery"), tenant)
  const details = { ...listQuery, productId, sku: history?.product.sku || "", from: listPath, warehouseId, fromWarehouseId: params.get("fromWarehouseId"), startDate, endDate, movementOffset: offset, direction, orderOffset, returnQuery }
  const back = returnQuery ? historyPath + "?" + returnQuery : stockUrl(listPath, { ...listQuery, focus: productId })
  function filter(startDate: string, endDate: string, movementOffset: number, type = direction, warehouse = warehouseId) {
    if (locked || !confirmNavigation()) return
    setReversal(null); setNotice("")
    window.history.pushState(null, "", stockUrl(path, { ...details, startDate, endDate, movementOffset, direction: type,
      warehouseId: warehouse, fromWarehouseId: warehouse === listQuery.warehouseId ? null : listQuery.warehouseId || "all", orderOffset: warehouse === warehouseId ? orderOffset : 0 }))
  }
  const clearFilters = (startDate || endDate || direction || (!manual && warehouseId)) && <Button type="button" variant="outline" disabled={locked}
    onClick={() => filter("", "", 0, "", manual ? warehouseId : null)}>Limpar filtros</Button>
  return <div className="workspace-page-frame">
    <PageHeader title={manual ? "Novo lançamento de estoque" : "Lançamentos de estoque"} back={{ href: back, label: "Voltar à consulta" }}
      actions={!manual && history && <StockAnalysisLink dataset="stock_movement_activity" tenant={tenant} productId={productId}
        warehouseId={warehouseId} direction={direction} startDate={startDate} endDate={endDate}>Atividade de movimentação do produto</StockAnalysisLink>} />
    {!history ? resource.loading ? <p role="status">Carregando movimentos…</p> : <div role="alert">
      <p>{resource.error || "O histórico retornou dados diferentes do produto ou da empresa ativa."}</p><Button variant="outline" onClick={resource.reload}>Recarregar histórico</Button>
      {clearFilters}</div> :
      <section aria-label="Movimentos do produto" className="form-section min-w-0 space-y-4">
        <h2 className="break-words font-semibold">{history.product.name}</h2>
        <p className="break-words">SKU {history.product.sku} • Unidade {history.product.unit}</p>
        <GuardedLink className={textLink} href={stockUrl("/relatorios/estoque/analises",{dataset:"stock_kardex",productId,tenant,warehouseId,startDate,endDate})}>Exportar Kardex do produto</GuardedLink>
        <GuardedLink className={textLink} href={"/compras/sugestoes/"+productId}>Consultar reposição</GuardedLink>
        <GuardedLink className={textLink} href={stockUrl("/estoque/series",{productId,tenant})}>Rastrear séries do produto</GuardedLink>
        {warehouseId && <p>Depósito • {history.warehouses?.find(w=>w.id===warehouseId)?.name || warehouseId}</p>}
        {!history.canEdit && <p>Somente consulta. Você não pode movimentar o estoque.</p>}
        {!manual && history.canEdit && <GuardedLink className={textLink} href={stockUrl(manualPath, details)}>Novo lançamento</GuardedLink>}
        {manual && history.canEdit && <StockMovementForm key={reversal?.id || "new"} product={history.product} tenant={tenant} reversal={reversal} warehouses={history.warehouses} selectedWarehouse={warehouseId}
          setLocked={value => { setLocked(value); if (value) setNotice("") }} resetReversal={() => setReversal(null)} confirmed={message => { setNotice(message); resource.reload() }} />}
        {notice && <p role="status">{notice}</p>}
        {manual && <GuardedLink className={textLink} href={stockUrl(historyPath, details)}>Consultar Kardex</GuardedLink>}
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          filter(String(data.get("startDate")), String(data.get("endDate")), 0, String(data.get("direction") || ""),
            data.has("warehouse") ? String(data.get("warehouse") || "") || null : warehouseId)
        }} key={startDate + endDate + direction + warehouseId}>
          {!manual && Boolean(history.warehouses?.length || warehouseId) && <label>Depósito do movimento
            <select className="block min-h-9 rounded border px-2" name="warehouse" defaultValue={warehouseId || ""} disabled={locked}>
              <option value="">Todos os depósitos</option>
              {warehouseId && !history.warehouses?.some(warehouse => warehouse.id === warehouseId) && <option value={warehouseId}>{warehouseId}</option>}
              {history.warehouses?.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} • {warehouse.name}</option>)}
            </select></label>}
          <label>Tipo de movimento<select className="block min-h-9 rounded border px-2" name="direction" defaultValue={direction} disabled={locked}>
            <option value="">Todos</option><option value="receipt">Entrada</option><option value="issue">Saída</option></select></label>
          <label>Data inicial<Input type="date" defaultValue={startDate} name="startDate" disabled={locked} /></label>
          <label>Data final<Input type="date" defaultValue={endDate} name="endDate" disabled={locked} /></label>
          <Button type="submit" variant="outline" disabled={locked}>Aplicar filtros</Button>
          {clearFilters}
        </form>
        {direction && <p>Os totais incluem todas as entradas e saídas do período.</p>}
        <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {([["Saldo inicial", "opening"], ["Entradas", "receipts"], ["Saídas", "issues"], ["Saldo final", "closing"]] as const).map(([label, key]) =>
            <div key={key} className="min-w-0 rounded border p-2"><dt className="text-sm">{label}</dt><dd className="font-medium tabular-nums [overflow-wrap:anywhere]">{commercialQuantity(history.summary[key])} {history.product.unit}</dd></div>)}
        </dl>
        {history.openOrders && <section className="space-y-2" aria-label="Reservas atuais">
          <h3 className="font-medium">Reservado atualmente • {commercialQuantity(history.openOrders.reserved)} {history.product.unit}</h3>
          {history.openOrders.data.length>0 && <ul>{history.openOrders.data.map(o=><li key={o.id}><GuardedLink className={textLink}
            href={(o.status==="production"?"/estoque/ordens-producao/":"/vendas/pedidos/")+o.id}>{o.status==="production"?"Produção do pedido":"Pedido"} {o.number}</GuardedLink> • {o.status==="production"?"Empenhado":o.status==="confirmed"?"Reservado":"Aceito"} • {commercialQuantity(o.quantity)} {history.product.unit}</li>)}</ul>}
          {history.openOrders.total>25 && <Pagination offset={orderOffset} total={history.openOrders.total} pageSize={25} maxOffset={100000}
            onOffsetChange={value=>{if(!locked && confirmNavigation()) window.history.pushState(null,"",stockUrl(path,{...details,orderOffset:value}))}}/>}
        </section>}
        <h3 className="font-medium">Histórico registrado</h3>
        {history.canEdit && <GuardedLink className={textLink} href={stockUrl("/estoque/fechamento",{productId,tenant})}>Informar valor do saldo de abertura</GuardedLink>}
        {history.data.length ? <ol className="divide-y border-y">{history.data.map(movement => <li key={movement.id} className="min-w-0 space-y-1 py-3 [overflow-wrap:anywhere]">
          <p>Data efetiva • {movement.effectiveDate?.split("-").reverse().join("/") || "Anterior ao controle"}</p>
          <strong>{movement.direction === "receipt" ? "Entrada" : "Saída"} de {commercialQuantity(movement.quantity)} {history.product.unit}</strong>
          {origins.map(([key,label,base]) => movement[key] && <p key={key}>
            <GuardedLink className={textLink} href={base+encodeURIComponent(movement[key])}>{label} • {movement[key]}</GuardedLink></p>)}
          {movement.transferId && <GuardedLink className={textLink} href={"/estoque/transferencias?documento="+movement.transferId}>Transferência • {movement.transferId}</GuardedLink>}
          <p>{movement.reason}</p><p>Saldo após o movimento • {commercialQuantity(warehouseId && movement.localBalanceAfter ? movement.localBalanceAfter : movement.balanceAfter)} {history.product.unit}</p>
          {movement.warehouseId && Boolean(history.warehouses?.length) && <p>Depósito • {history.warehouses?.find(w=>w.id===movement.warehouseId)?.name||movement.warehouseId}</p>}
          <p>Custo unitário • {stockMoney(movement.unitCost)} • Valor do movimento • {stockMoney(movement.movementValue)}</p>
          {history.canEdit && movement.direction==="receipt" && !movement.transferId && !movement.reversesId && <GuardedLink className={textLink}
            href={stockUrl("/estoque/fechamento",{tenant,productId,movementId:movement.id})}>Conferir composição do custo</GuardedLink>}
          <p>Registrado em <time dateTime={movement.occurredAt}>{new Date(movement.occurredAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</time></p>
          <p className="text-xs text-muted-foreground">ID • {movement.id}</p>
          {movement.returnSourceId && <p>Origem da devolução • {movement.returnSourceId}</p>}
          {movement.reversesId && <p>Estorno do movimento • {movement.reversesId}</p>}
          {manual && history.canEdit && movement.canReverse && <Button variant="outline" disabled={locked || history.product.status !== "active"}
            onClick={() => { if (confirmNavigation()) { setReversal(movement); setNotice("") } }}>Preparar estorno de {commercialQuantity(movement.quantity)}</Button>}
        </li>)}</ol> : <p>{history.total ? "Nenhum movimento nesta página." : startDate || endDate || direction || warehouseId ? "Nenhum movimento encontrado para os filtros selecionados." : "Nenhum movimento registrado para este produto."}</p>}
        {(history.total > pageSize || offset > 0) && <Pagination offset={offset} total={history.total} loading={locked} pageSize={pageSize} maxOffset={100000} onOffsetChange={value => filter(startDate, endDate, value)} />}
      </section>}
  </div>
}
