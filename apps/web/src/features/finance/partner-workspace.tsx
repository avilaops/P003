"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/page-header"
import { useResource, useCommand } from "@/hooks/use-operation"
import {
  fieldStyle,
  dateLabel,
  reais,
  sideLabels,
  titleUrl,
  type Portfolio,
  type PortfolioRow,
  type Side,
} from "./finance-insights-model"
import { OperationAction, ReviewHistory, type OperationReview } from "./operation-history"
import { PartnerOperations, operationNames, type FinancialOperation } from "./partner-operations"

type Party = { id: string; name: string; customer: boolean; supplier: boolean }
type PartnerData = {
  tenantId: string
  allowed: Side[]
  writable: Side[]
  canEditCredit: boolean
  party: Party
  position: {
    receivable: string
    payable: string
    overdueReceivable: string
    overduePayable: string
    averageDays: string | null
    unbilled: string
    creditLimit: string | null
    creditAvailable: string | null
    orders: { id: string; number: string; amount: string }[]
    purchaseOrders: { id: string; number: string; amount: string }[]
  }
}
function CreditLimit({ data, etag, onSaved }: { data: PartnerData; etag: string; onSaved: () => void }) {
  const [limit, setLimit] = useState(data.position.creditLimit ?? "")
  const [notice, setNotice] = useState("")
  const command = useCommand()
  if (!data.canEditCredit || !data.party.customer) return null
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const answer = await command.send(
          "/api/erp/finance/partner/credit",
          data.tenantId,
          { partyId: data.party.id, limit: limit.replace(",", ".") },
          etag,
          "PUT",
        )
        if (answer) {
          onSaved()
          setNotice("Limite atualizado.")
        }
      }}
    >
      <label className="grid gap-1 text-sm">
        Limite de crédito (R$)
        <input
          className={fieldStyle}
          required
          inputMode="decimal"
          pattern="[0-9]+([.,][0-9]{1,2})?"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </label>
      <Button type="submit" variant="outline" disabled={command.busy}>
        Salvar limite
      </Button>
      {command.error ? <span role="alert">{command.error}</span> : <span role="status">{notice}</span>}
    </form>
  )
}

export function PartnerWorkspace({ group = false }: { group?: boolean }) {
  return (
    <Suspense fallback={<p role="status">Consultando parceiros…</p>}>
      <PartnerSelector group={group} />
    </Suspense>
  )
}
function PartnerSelector({ group }: { group: boolean }) {
  const params = useSearchParams()
  const [id, setId] = useState(params.get("partyId") ?? "")
  const [query, setQuery] = useState("")
  const result = useResource<{ data: Party[] }>("/api/erp/finance/partners?q=" + encodeURIComponent(query))
  return (
    <main className="workspace-page-frame space-y-5">
      <PageHeader
        eyebrow="Financeiro"
        title={group ? "Faturamento agrupado" : "Ficha financeira"}
        back={{ href: "/financeiro", label: "Financeiro" }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">
          Buscar parceiro
          <input
            className={fieldStyle}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nome ou documento"
          />
        </label>
        <label className="grid gap-1">
          {group ? "Cliente" : "Cliente ou fornecedor"}
          <select className={fieldStyle} value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Selecione</option>
            {id && !result.value?.data.some((p) => p.id === id) && <option value={id}>Parceiro selecionado</option>}
            {result.value?.data
              .filter((p) => !group || p.customer)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {result.error && <p role="alert">{result.error}</p>}
      {id && <PartnerPosition key={id} id={id} group={group} />}
    </main>
  )
}
function PartnerPosition({ id, group }: { id: string; group: boolean }) {
  const [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<PortfolioRow[]>([])
  const [status, setStatus] = useState(group ? "open" : "")
  const position = useResource<PartnerData>("/api/erp/finance/partner?partyId=" + id)
  const titles = useResource<Portfolio>(
    "/api/erp/finance/portfolio?partyId=" +
      id +
      "&limit=30&offset=" +
      offset +
      (status ? "&status=" + status : "") +
      (group ? "&side=receivable" : ""),
  )
  const history = useResource<{ tenantId: string; data: FinancialOperation[]; reviews: OperationReview[] }>(
    "/api/erp/finance/operations?partyId=" + id,
  )
  const data = position.value
  function reload() {
    setSelected([])
    position.reload()
    titles.reload()
    history.reload()
  }
  if (!data) return <p role={position.error ? "alert" : "status"}>{position.error || "Carregando ficha financeira…"}</p>
  const p = data.position
  const metrics = [
    ...(data.allowed.includes("receivable")
      ? [
          ["A receber", reais(p.receivable)],
          ["Recebíveis vencidos", reais(p.overdueReceivable)],
          ["Crédito disponível", p.creditAvailable === null ? "Sem limite cadastrado" : reais(p.creditAvailable)],
          ["Pedidos a faturar", reais(p.unbilled)],
        ]
      : []),
    ...(data.allowed.includes("payable")
      ? [
          ["A pagar", reais(p.payable)],
          ["Pagamentos vencidos", reais(p.overduePayable)],
        ]
      : []),
    ["Prazo médio de liquidação", p.averageDays === null ? "Sem baixas" : p.averageDays.replace(".", ",") + " dias"],
  ]
  return (
    <section className="space-y-5">
      <h2 className="text-xl font-semibold">{data.party.name}</h2>
      {!group && (
        <>
          <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {metrics.map(([k, v]) => (
              <div className="rounded-lg border p-3" key={k}>
                <dt className="text-sm">{k}</dt>
                <dd className="font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <CreditLimit key={position.etag} data={data} etag={position.etag} onSaved={position.reload} />
          {p.orders.length > 0 && (
            <details>
              <summary className="cursor-pointer">Pedidos a faturar • {p.orders.length}</summary>
              <ul className="space-y-2 p-3">
                {p.orders.map((o) => (
                  <li key={o.id}>
                    <Link className="underline" href={"/vendas/pedidos/" + o.id}>
                      Pedido {o.number} • {reais(o.amount)}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Títulos do parceiro</h3>
        {!group && (
          <label>
            Situação{" "}
            <select
              className={fieldStyle}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setOffset(0)
              }}
            >
              <option value="">Todas</option>
              <option value="open">Em aberto</option>
              <option value="paid">Liquidados</option>
              <option value="cancelled">Cancelados</option>
            </select>
          </label>
        )}
      </div>
      {titles.error ? (
        <p role="alert">{titles.error}</p>
      ) : titles.loading ? (
        <p role="status">Consultando títulos…</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {titles.value?.rows.map((r) => (
            <li className="flex flex-wrap items-center gap-3 px-3 py-2" key={r.id}>
              {r.status === "open" && data.writable.includes(r.side) && (
                <input
                  aria-label={"Selecionar " + sideLabels[r.side] + " " + dateLabel(r.dueDate) + " " + reais(r.outstanding)}
                  type="checkbox"
                  checked={selected.some((t) => t.id === r.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, r] : selected.filter((x) => x.id !== r.id))}
                />
              )}
              <Link href={titleUrl(r)} className="text-primary underline">
                {sideLabels[r.side]} • {dateLabel(r.dueDate)}
              </Link>
              <span>
                Original {reais(r.amount)} • saldo {reais(r.outstanding)}
              </span>
            </li>
          ))}
          {!titles.value?.total && <li className="p-3">Nenhum título no filtro.</li>}
        </ul>
      )}
      {titles.value && titles.value.total > 30 && (
        <div className="flex gap-2">
          <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(offset - 30)}>
            Anterior
          </Button>
          <Button variant="outline" disabled={offset + 30 >= titles.value.total} onClick={() => setOffset(offset + 30)}>
            Próxima
          </Button>
        </div>
      )}
      {(group ? data.writable.includes("receivable") : data.writable.length > 0) && (
        <PartnerOperations
          tenantId={data.tenantId}
          partyId={id}
          writable={data.writable}
          selected={selected}
          history={history.value?.data ?? []}
          orders={p.orders}
          purchaseOrders={p.purchaseOrders ?? []}
          group={group}
          onSaved={reload}
        />
      )}
      <ReviewHistory reviews={history.value?.reviews ?? []} tenantId={data.tenantId} onSaved={reload} />
      <h3 className="font-semibold">Histórico financeiro</h3>
      {history.error && <p role="alert">{history.error}</p>}
      <ul className="space-y-2">
        {history.value?.data.map((o) => (
          <li key={o.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap gap-2">
              <strong>{operationNames[o.kind]}</strong>
              <span>
                {dateLabel(o.occurredOn)} • {reais(o.amount)}
              </span>
            </div>
            <p>{o.reason}</p>
            {o.kind === "advance" && <span>Disponível para compensar • {reais(o.available)}</span>}
            {o.items.map((i, index) => (
              <Link className="mr-3 inline-block text-primary underline" key={i.id} href={titleUrl(i)}>
                Título {index + 1} • {reais(i.amount)}
              </Link>
            ))}
            {o.kind === "billing_group" && !o.reversedOn && (
              <Link
                className="block text-primary underline"
                href={"/financeiro/remessas-retornos?groupId=" + o.id + "&partyId=" + id}
              >
                Emitir ou consultar cobrança do grupo
              </Link>
            )}
            {o.reversedOn ? (
              <p>
                Estornada em {dateLabel(o.reversedOn)} • {o.reversalReason}
              </p>
            ) : (
              data.writable.includes(o.side) &&
              (o.kind !== "offset" || data.writable.length === 2) && (
                <OperationAction id={o.id} tenantId={data.tenantId} onSaved={reload} />
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
