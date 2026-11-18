"use client"

import Link from "next/link"
import { useResource } from "@/hooks/use-operation"
import { dateLabel, reais, type Portfolio, type Side } from "./finance-insights-model"

type Account = {
  id: string
  name: string
  balance: string
  bankBalance: string | null
  statementThrough: string | null
  matchedNet: string | null
}
function shift(date: string, days: number) {
  const d = new Date(date + "T12:00:00Z")
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
export function OverviewBalances() {
  const position = useResource<Portfolio>("/api/erp/finance/portfolio?limit=1")
  const accounts = useResource<{ data: Account[] }>("/api/erp/finance/balances")
  const value = position.value
  const cards: { label: string; amount: string; side: Side; period: string }[] = value
    ? [
        { label: "A receber", amount: value.totals.receivable, side: "receivable", period: "" },
        { label: "A pagar", amount: value.totals.payable, side: "payable", period: "" },
        {
          label: "Recebíveis vencidos",
          amount: value.totals.overdueReceivable,
          side: "receivable",
          period: "&to=" + shift(value.asOf, -1),
        },
        {
          label: "Pagamentos vencidos",
          amount: value.totals.overduePayable,
          side: "payable",
          period: "&to=" + shift(value.asOf, -1),
        },
        {
          label: "A receber nos próximos 7 dias",
          amount: value.totals.weekReceivable,
          side: "receivable",
          period: "&from=" + value.asOf + "&to=" + shift(value.asOf, 6),
        },
        {
          label: "A pagar nos próximos 7 dias",
          amount: value.totals.weekPayable,
          side: "payable",
          period: "&from=" + value.asOf + "&to=" + shift(value.asOf, 6),
        },
      ]
    : []
  return (
    <section className="space-y-3">
      {position.loading ? (
        <p role="status">Consultando carteiras…</p>
      ) : position.error ? (
        <p role="alert">{position.error}</p>
      ) : (
        value && (
          <>
            <h2 className="text-lg font-semibold">Posição em {dateLabel(value.asOf)}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards
                .filter((c) => value.allowed.includes(c.side))
                .map((c) => (
                  <Link
                    className="rounded-lg border p-4 hover:border-primary"
                    key={c.label}
                    href={"/financeiro/relatorios?status=open&side=" + c.side + c.period}
                  >
                    <span className="text-sm">{c.label}</span>
                    <strong className="block text-2xl">{reais(c.amount)}</strong>
                  </Link>
                ))}
            </div>
          </>
        )
      )}
      {accounts.error && accounts.status !== 403 && <p role="alert">{accounts.error}</p>}
      {accounts.value?.data.length ? (
        <>
          <h2 className="text-lg font-semibold">Saldo por conta</h2>
          <ul className="grid gap-2 sm:grid-cols-3">
            {accounts.value.data.map((a) => (
              <li key={a.id}>
                <Link href={"/financeiro/caixas-bancos?accountId=" + a.id} className="block rounded-lg border p-3">
                  <strong>{a.name}</strong>
                  <p>Saldo interno • {reais(a.balance)}</p>
                  {a.statementThrough && a.bankBalance !== null && (
                    <>
                      <p>
                        Extrato em {dateLabel(a.statementThrough)} • {reais(a.bankBalance)}
                      </p>
                      <p>Movimento líquido conciliado até essa data • {reais(a.matchedNet ?? "0.00")}</p>
                    </>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
