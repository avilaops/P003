"use client"

import { useState, useRef } from "react"
import { erpFetch } from "@/lib/api/client"
import { decimalPattern, normalizeDecimal } from "@/lib/decimal-input"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useNavigationGuard } from "@/components/shell/navigation-guard"
import { commercialQuantity } from "@/features/sales/order-presentation"
import type { Movement, StockProduct } from "./stock-model"
import type { Warehouse } from "./stock-location-model"

export function StockMovementForm({ tenant, product, reversal, resetReversal, confirmed, setLocked, warehouses, selectedWarehouse }: {
  tenant: string; product: StockProduct; reversal: Movement | null; resetReversal: () => void
  warehouses?: Warehouse[] | undefined; selectedWarehouse?: string | null
  confirmed: (message: string) => void; setLocked: (value: boolean) => void
}) {
  const [direction, setDirection] = useState<"receipt" | "issue">(reversal?.direction === "receipt" ? "issue" : "receipt")
  const [quantity, setQuantity] = useState(reversal?.quantity || "")
  const [reason, setReason] = useState("")
  const [warehouseId,setWarehouse] = useState(selectedWarehouse||"")
  const [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState("")
  const pending = useRef(false), command = useRef<{ key: string; body: string } | null>(null)
  useNavigationGuard(quantity || reason || reversal || uncertain ? "Descartar o lançamento ainda não confirmado?" : null)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (pending.current || product.status !== "active") return
    const normalized = normalizeDecimal(quantity, 6)
    if (!uncertain && (!normalized || normalized === "0.000000")) { setError("Informe quantidade positiva com até seis casas decimais"); return }
    if (!uncertain) command.current = { key: crypto.randomUUID(),
      body: JSON.stringify({ productId: product.productId, direction, quantity: normalized, reason, reversesId: reversal?.id || null,
        ...(!reversal && warehouseId ? {warehouseId} : {}) }) }
    const attempt = command.current!
    pending.current = true
    setSaving(true); setLocked(true); setError("")
    try {
      const response = await erpFetch("/api/erp/stock/movements", { method: "POST", body: attempt.body,
        headers: { "Content-Type": "application/json", "X-Tenant-Id": tenant, "Idempotency-Key": attempt.key } })
      const body = await response.json()
      if (!response.ok) {
        const retry = response.status >= 500 || uncertain
        setUncertain(retry); setLocked(retry); setError(body.title || "Lançamento recusado")
        return
      }
      if (body.productId !== product.productId || typeof body.balanceAfter !== "string") throw new Error()
      command.current = null
      setUncertain(false); setLocked(false); setDirection("receipt"); setReason(""); setQuantity("")
      const message = `Movimento confirmado. Saldo após o lançamento: ${commercialQuantity(body.balanceAfter)} ${product.unit}.`
      if (reversal) resetReversal()
      confirmed(message)
    } catch {
      setUncertain(true); setLocked(true); setError("A resposta não confirmou o resultado. Repita a confirmação com a mesma chave.")
    } finally {
      pending.current = false; setSaving(false)
    }
  }
  return <form className="space-y-3" onSubmit={save}>
    <h3 className="font-semibold">{reversal ? "Estornar movimento" : "Novo lançamento"}</h3>
    {reversal && <p className="break-all">Movimento original • {reversal.id}</p>}
    <fieldset disabled={saving || uncertain || product.status !== "active"} className="grid min-w-0 gap-3 sm:grid-cols-2">
      {Boolean(warehouses?.length) && !reversal && <label>Depósito<select className="block h-9 w-full rounded-lg border px-3" value={warehouseId} onChange={e=>setWarehouse(e.target.value)}>
        <option value="">Depósito de abertura</option>{warehouses?.map(w=><option key={w.id} value={w.id}>{w.code} • {w.name}</option>)}</select></label>}
      <label>Direção<select className="block h-9 w-full rounded-lg border px-3" value={direction} disabled={Boolean(reversal)}
        onChange={event => setDirection(event.target.value as typeof direction)}><option value="receipt">Entrada</option><option value="issue">Saída</option></select></label>
      <label>Quantidade (vírgula ou ponto)<Input required inputMode="decimal" pattern={decimalPattern(6)} maxLength={19} disabled={Boolean(reversal)} value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
      <label className="sm:col-span-2">Motivo<Input required minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
    </fieldset>
    {product.status !== "active" && <p>Reative o produto no catálogo antes de movimentar.</p>}
    {error && <p role="alert">{error}</p>}
    <Button type="submit" disabled={saving || product.status !== "active"}>{saving ? "Confirmando…" : uncertain ? "Repetir confirmação" : reversal ? "Confirmar estorno" : "Confirmar lançamento"}</Button>
    {reversal && <Button type="button" variant="outline" disabled={saving || uncertain} onClick={resetReversal}>Cancelar estorno</Button>}
  </form>
}
