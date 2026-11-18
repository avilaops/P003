"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { normalizeDecimal } from "@/lib/decimal-input"

export type Policy = {
  id: string
  productId: string | null
  productName: string | null
  productLine: "national" | "imported" | null
  trigger: "receipt" | "invoice"
  commissionRate: string
}
const field = "block h-9 w-full rounded-lg border bg-background px-2 text-sm"

export function CommissionPolicyForm({
  id,
  tenant,
  etag,
  canEdit,
  policies,
  refresh,
}: {
  id: string
  tenant: string
  etag: string
  canEdit: boolean
  policies: Policy[]
  refresh: () => void
}) {
  const [scope, setScope] = useState("seller"),
    [query, setQuery] = useState(""),
    [product, setProduct] = useState(""),
    [line, setLine] = useState("national"),
    [rate, setRate] = useState(""),
    [trigger, setTrigger] = useState("receipt")
  const command = useCommand()
  return (
    <section className="space-y-3">
      <h3 className="font-semibold">Políticas de comissão</h3>
      <p className="text-sm text-muted-foreground">
        No aceite do pedido, prevalece a regra do produto, seguida da linha e do vendedor. Sem regra, vale o percentual
        do pedido sobre o recebimento.
      </p>
      {policies.length > 0 && (
        <ul>
          {policies.map((p) => (
            <li key={p.id}>
              {p.productName ??
                (p.productLine === "national"
                  ? "Linha nacional"
                  : p.productLine === "imported"
                    ? "Linha importada"
                    : "Vendedor")}{" "}
              • {p.commissionRate.replace(".", ",")}% • {p.trigger === "invoice" ? "NF-e autorizada" : "Recebimento"}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            const commissionRate = normalizeDecimal(rate, 4)
            if (!commissionRate) return
            const result = await command.send(
              "/api/erp/commissions/" + id + "/policies",
              tenant,
              {
                productId: scope === "product" ? product : null,
                productLine: scope === "line" ? line : null,
                trigger,
                commissionRate,
              },
              etag,
            )
            if (result) {
              setRate("")
              refresh()
            }
          }}
        >
          <fieldset disabled={command.busy || command.uncertain || command.stale} className="grid gap-3 sm:grid-cols-2">
            <label>
              Abrangência da política
              <select className={field} value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="seller">Vendedor</option>
                <option value="line">Linha</option>
                <option value="product">Produto</option>
              </select>
            </label>
            {scope === "line" && (
              <label>
                Linha de produtos
                <select className={field} value={line} onChange={(e) => setLine(e.target.value)}>
                  <option value="national">Nacional</option>
                  <option value="imported">Importada</option>
                </select>
              </label>
            )}
            {scope === "product" && (
              <>
                <label>
                  Buscar produto
                  <Input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setProduct("")
                    }}
                  />
                </label>
                <ProductSelect tenant={tenant} query={query} value={product} select={setProduct} />
              </>
            )}
            <label>
              Apurar comissão no
              <select className={field} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                <option value="receipt">Recebimento de principal</option>
                <option value="invoice">Faturamento • NF-e autorizada</option>
              </select>
            </label>
            <label>
              Percentual da política
              <Input
                required
                pattern="[0-9]+([.,][0-9]{1,4})?"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </label>
          </fieldset>
          {command.error && <p role="alert">{command.error}</p>}
          {command.stale && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                command.reset()
                refresh()
              }}
            >
              Recarregar políticas
            </Button>
          )}
          <Button type="submit" className="mt-3" disabled={command.busy || command.stale || !etag}>
            {command.uncertain ? "Repetir confirmação" : "Salvar política"}
          </Button>
        </form>
      )}
    </section>
  )
}
function ProductSelect({
  tenant,
  query,
  value,
  select,
}: {
  tenant: string
  query: string
  value: string
  select: (s: string) => void
}) {
  const result = useResource<{ tenantId: string; data: { id: string; name: string; sku: string }[] }>(
    "/api/erp/products?status=active&limit=100&q=" + encodeURIComponent(query),
  )
  return (
    <label>
      Produto da política
      <select className={field} required value={value} onChange={(e) => select(e.target.value)}>
        <option value="">Selecione o produto</option>
        {result.value?.tenantId === tenant &&
          result.value.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} • {p.name}
            </option>
          ))}
      </select>
      {result.error && <span role="alert">{result.error}</span>}
    </label>
  )
}
