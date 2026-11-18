"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useResource } from "@/hooks/use-operation"
import { downloadCsv } from "@/lib/csv-export"
import { dateLabel, fieldStyle, localDay, reais, sideLabels, type Side } from "./finance-insights-model"

type CashDay = {
  date: string
  opening: string
  cashIn: string
  cashOut: string
  forecastIn: string
  forecastOut: string
  realized: string
  projected: string
}
type Line = { kind: Side; category: string; amount: string }
export function FinanceStatements({ type }: { type: "income" | "cashflow" }) {
  const today = localDay(),
    month = today.slice(0, 7)
  const [from, setFrom] = useState(month + "-01"),
    [to, setTo] = useState(today)
  const [account, setAccount] = useState(""),
    [category, setCategory] = useState("")
  const [interval, setInterval] = useState("day"),
    [withFixed, setFixed] = useState(false)
  const [withOrders, setOrders] = useState(false)
  const cash = type === "cashflow"
  const args = new URLSearchParams({ from, to })
  if (category) args.set("categoryId", category)
  if (cash) {
    args.set("interval", interval)
    if (account) args.set("accountId", account)
    if (withFixed && !account) args.set("fixed", "yes")
    if (withOrders && !account && !category) args.set("orders", "yes")
  }
  const accounts = useResource<{ data: { id: string; name: string }[] }>(cash ? "/api/erp/financial-accounts?limit=100" : "")
  const categories = useResource<{ data: { id: string; name: string }[] }>("/api/erp/financial-categories?limit=100")
  const result = useResource<{ tenantId: string; result?: string; data: (CashDay | Line)[] }>(
    "/api/erp/finance/" + (cash ? "cashflow" : "income-statement") + "?" + args,
  )
  const columns = cash
    ? ["Data", "Entradas", "Saídas", "A receber", "A pagar", "Saldo realizado", "Saldo projetado"]
    : ["Grupo", "Natureza", "Valor"]
  const values = (result.value?.data ?? []).map((row) =>
    "date" in row
      ? [
          dateLabel(row.date),
          reais(row.cashIn),
          reais(row.cashOut),
          reais(row.forecastIn),
          reais(row.forecastOut),
          reais(row.realized),
          reais(row.projected),
        ]
      : [sideLabels[row.kind] === "A receber" ? "Receitas" : "Despesas", row.category, reais(row.amount)],
  )
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">
          De
          <input className={fieldStyle} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="grid gap-1">
          Até
          <input className={fieldStyle} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="grid gap-1">
          Natureza
          <select className={fieldStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Todas</option>
            {categories.value?.data.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {cash && (
          <>
            <label className="grid gap-1">
              Conta
              <select className={fieldStyle} value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">Consolidado</option>
                {accounts.value?.data.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              Agrupar por
              <select className={fieldStyle} value={interval} onChange={(e) => setInterval(e.target.value)}>
                <option value="day">Dia</option>
                <option value="week">Semana</option>
                <option value="month">Mês</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={withFixed}
                disabled={Boolean(account)}
                onChange={(e) => setFixed(e.target.checked)}
              />{" "}
              Incluir previsão de despesas fixas
            </label>
            <label>
              <input
                type="checkbox"
                checked={withOrders}
                disabled={Boolean(account || category)}
                onChange={(e) => setOrders(e.target.checked)}
              />{" "}
              Incluir saldo de pedidos aceitos ainda sem título
            </label>
          </>
        )}
      </div>
      {result.loading ? (
        <p role="status">Consultando movimentos…</p>
      ) : result.error ? (
        <p role="alert">{result.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {cash
                ? "Saldo inicial do período • " + reais((result.value?.data[0] as CashDay | undefined)?.opening ?? "0.00")
                : "Resultado por competência • " + reais(result.value?.result ?? "0.00")}
            </p>
            <Button
              variant="outline"
              disabled={!values.length}
              onClick={() =>
                downloadCsv(cash ? "fluxo-de-caixa.csv" : "dre-gerencial.csv", [
                  columns,
                  ...values.map((r) => r.map((v) => (/^[=+@-]/.test(v) ? "'" + v : v))),
                ])
              }
            >
              Exportar CSV
            </Button>
          </div>
          {cash && (
            <p className="text-sm text-muted-foreground">
              A projeção considera saldos em aberto por vencimento. Valores vencidos entram no primeiro dia projetado. Ao filtrar
              uma conta, entram na previsão os títulos destinados a ela.
            </p>
          )}
          {!values.length ? (
            <p>Nenhum lançamento no período.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} className="p-2">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {values.map((r, i) => (
                    <tr key={i} className="border-t">
                      {r.map((v, j) => (
                        <td key={j} className="p-2">
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
