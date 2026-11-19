"use client"

import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { useResource } from "@/hooks/use-operation"
import { commercialQuantity } from "@/features/sales/order-presentation"
import { historyPath, stockMoney, stockUrl, textLink, type Movement, type StockProduct } from "./stock-model"
import { movementOrigins } from "./stock-history"

export type MovementDetail = { tenantId: string; canEdit: boolean; product: StockProduct
  warehouse: { id: string; code: string; name: string } | null
  movement: Movement & { reversedBy: string | null; effectiveDate: string | null } }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const day = (value: string | null) => value ? value.split("-").reverse().join("/") : "Anterior ao controle"

export function StockMovementDetail({ id, tenant }: { id: string; tenant: string }) {
  if (uuid.test(id)) return <LoadedMovement id={id} tenant={tenant} />
  return <div className="workspace-page-frame"><PageHeader eyebrow="Estoque / Lançamentos" title="Detalhe de lançamento" back={{ href: historyPath, label: "Voltar aos lançamentos" }} />
    <p role="alert">Identificador de lançamento inválido.</p></div>
}

function LoadedMovement({ id, tenant }: { id: string; tenant: string }) {
  const resource = useResource<MovementDetail>("/api/erp/stock/movements/" + id.toLowerCase())
  const detail = resource.value?.tenantId === tenant && resource.value.movement.id === id.toLowerCase() ? resource.value : null
  const kardex = detail ? stockUrl(historyPath, { tenant, productId: detail.product.productId, sku: detail.product.sku,
    warehouseId: detail.warehouse?.id ?? null }) : historyPath
  const header = <PageHeader eyebrow="Estoque / Lançamentos" title="Detalhe de lançamento" back={{ href: kardex, label: detail ? "Voltar ao Kardex" : "Voltar aos lançamentos" }} />
  if (!detail) return <div className="workspace-page-frame">{header}{resource.loading ? <p role="status">Carregando lançamento…</p> :
    <div role="alert" className="space-y-2"><p>{resource.error || "O lançamento não pertence à empresa ativa."}</p>
      <Button variant="outline" onClick={resource.reload}>Recarregar lançamento</Button></div>}</div>
  const { movement, product, warehouse } = detail
  const unit = product.unit
  const rows: [string, React.ReactNode][] = [
    ["Tipo", movement.direction === "receipt" ? "Entrada" : "Saída"],
    ["Quantidade", `${commercialQuantity(movement.quantity)} ${unit}`],
    ["Data efetiva", day(movement.effectiveDate)],
    ["Registrado em", <time key="t" dateTime={movement.occurredAt}>{new Date(movement.occurredAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</time>],
    ["Depósito", warehouse ? `${warehouse.code} • ${warehouse.name}` : "Consolidado"],
    ["Saldo após o movimento", `${commercialQuantity(movement.balanceAfter)} ${unit}`],
    ...(warehouse && movement.localBalanceAfter ? [["Saldo no depósito", `${commercialQuantity(movement.localBalanceAfter)} ${unit}`] as [string, string]] : []),
    ["Custo unitário", stockMoney(movement.unitCost)],
    ["Valor do movimento", stockMoney(movement.movementValue)],
    ["Motivo", movement.reason],
  ]
  return <div className="workspace-page-frame">
    {header}
    <section aria-label="Lançamento de estoque" className="form-section min-w-0 space-y-3 [overflow-wrap:anywhere]">
      <h2 className="font-semibold">{product.name}</h2>
      <p className="text-sm">SKU {product.sku} • ID {movement.id}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
        {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>)}
      </dl>
      <h3 className="font-medium">Documentos vinculados</h3>
      <ul className="text-sm">
        {movementOrigins.map(([key, label, base]) => movement[key] && <li key={key}>
          <Link className={textLink} href={base + encodeURIComponent(movement[key])}>{label} • {movement[key]}</Link></li>)}
        {movement.transferId && <li><Link className={textLink} href={"/estoque/transferencias?documento=" + movement.transferId}>Transferência • {movement.transferId}</Link></li>}
        {movement.returnSourceId && <li>Origem da devolução • {movement.returnSourceId}</li>}
        {movement.reversesId && <li><Link className={textLink} href={stockUrl(historyPath + "/" + movement.reversesId, { tenant })}>Estorno do lançamento • {movement.reversesId}</Link></li>}
        {movement.reversedBy && <li><Link className={textLink} href={stockUrl(historyPath + "/" + movement.reversedBy, { tenant })}>Estornado pelo lançamento • {movement.reversedBy}</Link></li>}
        {!movementOrigins.some(([key]) => movement[key]) && !movement.transferId && !movement.reversesId && !movement.reversedBy && !movement.returnSourceId &&
          <li>Lançamento manual, sem documento de origem.</li>}
      </ul>
      {detail.canEdit && movement.canReverse && <Link className={textLink} href={stockUrl(historyPath + "/novo", { tenant, productId: product.productId, sku: product.sku })}>Estornar no lançamento manual</Link>}
      <Link className={textLink} href={kardex}>Consultar Kardex do produto</Link>
    </section>
  </div>
}
