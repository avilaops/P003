"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RequestError } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"
import { downloadCsv } from "@/lib/csv-export"
import { dateLabel, reais } from "./finance-insights-model"

type Title = { id: string; name: string; partyId: string; cents: string; dueOn: string }
type Batch = {
  id: string
  accountId: string
  accountName: string
  reference: string
  createdAt: string
  createdBy: string
  cancelledAt: string | null
  cancelledBy: string | null
  cancelReason: string | null
}
type Event = { at: string; key: string; source: string; outcome: string }
type Item = Title & {
  state: string
  method: string | null
  chargeId: string | null
  providerId: string | null
  settledAt: string | null
  paymentId: string | null
  reviewReason: string | null
  events: Event[]
}
type Result<T> = { tenantId: string; canEdit: boolean; data: T }
type List = {
  accounts: { id: string; name: string }[]
  candidates: Title[]
  history: (Batch & { count: number; cents: string })[]
  more: boolean
  moreHistory: boolean
}
type Details = { batch: Batch; items: Item[]; canIssue: boolean }
type Connection = { id: string; live: boolean }
const root = "/api/erp/finance-treasury/"
const label: Record<string, string> = {
  selected: "Preparado",
  prepared: "Emissão reservada",
  issued: "Emitido",
  paid: "Liquidado",
  review: "Em conferência",
  cancelled: "Cancelado",
  report: "Arquivo de retorno",
  report_divergence: "Arquivo de retorno",
  divergent: "Divergência com o provedor",
  webhook: "Notificação bancária",
  issuance: "Emissão",
}
const time = (day: string) => new Date(day).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
const csvCell = (s: string) => (/^\s*[=+@-]|^[\t\r\n]/.test(s) ? "'" + s : s)
function brl(cents: string) {
  const amount = BigInt(cents)
  const unit = BigInt(100)
  return reais((amount / unit).toString() + "." + (amount % unit).toString().padStart(2, "0"))
}

function BatchDetail({
  id,
  tenant,
  connections,
  back,
}: {
  id: string
  tenant: string
  connections: Connection[]
  back: () => void
}) {
  const resource = useResource<Result<Details>>(root + "batches?batchId=" + id)
  const command = useCommand(),
    [method, setMethod] = useState("PIX"),
    [reason, setReason] = useState("")
  const result = resource.value?.tenantId === tenant ? resource.value : null
  const frozen = command.busy || command.uncertain || command.stale
  async function submit(path: string, body: object) {
    const response = await command.send<Result<unknown>>(
      root + path,
      tenant,
      body,
      "",
      "POST",
      (v) => v.tenantId === tenant,
    )
    if (response) resource.reload()
  }
  if (resource.error) return <RequestError message={resource.error} status={resource.status} />
  if (!result) return <p role="status">Carregando borderô…</p>
  const { batch, items, canIssue } = result.data,
    provider = connections.find((a) => a.id === batch.accountId)
  const exportFile = () =>
    downloadCsv("bordero-" + id + ".csv", [
      [
        "Borderô",
        "Referência",
        "Conta",
        "Cliente",
        "Título",
        "Vencimento",
        "Valor preparado",
        "Situação",
        "ID da cobrança",
        "ID no provedor",
        "Baixa",
        "Ocorrências",
      ],
      ...items.map((i) =>
        [
          id,
          batch.reference,
          batch.accountName,
          i.name,
          i.id,
          i.dueOn,
          brl(i.cents),
          label[i.state] ?? i.state,
          i.chargeId ?? "",
          i.providerId ?? "",
          i.paymentId ?? "",
          i.events
            .map((e) => [time(e.at), label[e.source] ?? e.source, label[e.outcome] ?? e.outcome].join(" • "))
            .join("\n"),
        ].map(csvCell),
      ),
    ])
  return (
    <div className="space-y-3">
      <Button type="button" variant="outline" disabled={frozen} onClick={back}>
        Voltar aos borderôs
      </Button>
      <p>
        <strong>{batch.reference}</strong> • {batch.accountName} • {items.length} título(s) •{" "}
        {brl(items.reduce((a, i) => a + BigInt(i.cents), BigInt(0)).toString())}
      </p>
      <p>
        Preparado em {time(batch.createdAt)} • {batch.createdBy}
      </p>
      {batch.cancelledAt && (
        <p>
          Cancelado em {time(batch.cancelledAt)} • {batch.cancelledBy} • {batch.cancelReason}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={exportFile}>
          Exportar conferência CSV
        </Button>
        <Button type="button" variant="outline" disabled={frozen} onClick={resource.reload}>
          Atualizar ocorrências
        </Button>
      </div>
      {!batch.cancelledAt && provider && canIssue && (
        <label className="block">
          Meio de cobrança
          <select
            className="ml-2 rounded border p-2"
            value={method}
            disabled={frozen}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="PIX">Pix</option>
            <option value="BOLETO">Boleto</option>
          </select>
        </label>
      )}
      {!batch.cancelledAt && !provider && <p>Para emitir, vincule esta conta a um provedor de cobrança.</p>}
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.id} className="rounded border p-3">
            <p>
              <strong>{i.name}</strong> • {dateLabel(i.dueOn)} • {brl(i.cents)} • {label[i.state] ?? i.state}
            </p>
            <p className="text-sm">Título {i.id}</p>
            {i.chargeId && (
              <p className="text-sm">
                Cobrança {i.chargeId} • {i.method}
                {i.providerId && " • Provedor " + i.providerId}
              </p>
            )}
            {i.paymentId && i.settledAt && (
              <p>
                Baixa {i.paymentId} • {time(i.settledAt)}
              </p>
            )}
            {i.reviewReason && <p>{i.reviewReason}</p>}
            {i.events.map((e) => (
              <p key={e.source + ":" + e.key}>
                {time(e.at)} • {label[e.source] ?? e.source} • {label[e.outcome] ?? e.outcome}
              </p>
            ))}
            {result.canEdit &&
              canIssue &&
              provider &&
              !batch.cancelledAt &&
              ["selected", "prepared"].includes(i.state) && (
                <Button
                  type="button"
                  disabled={frozen}
                  onClick={() =>
                    submit("issue-charge", {
                      batchId: id,
                      accountId: batch.accountId,
                      billingType: i.method ?? method,
                      receivableIds: [i.id],
                    })
                  }
                >
                  {i.state === "prepared"
                    ? "Consultar emissão"
                    : provider.live
                      ? "Emitir cobrança"
                      : "Emitir em homologação"}
                </Button>
              )}
          </li>
        ))}
      </ul>
      {result.canEdit && !batch.cancelledAt && !items.some((i) => i.chargeId) && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit("cancel-batch", { batchId: id, reason })
          }}
        >
          <label className="block">
            Motivo do cancelamento
            <Input
              required
              minLength={3}
              maxLength={300}
              value={reason}
              disabled={frozen}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" disabled={frozen}>
            Cancelar borderô e liberar títulos
          </Button>
        </form>
      )}
      {command.uncertain && (
        <Button type="button" disabled={command.busy} onClick={() => submit("", {})}>
          Consultar resultado da operação
        </Button>
      )}
      {command.error && <RequestError message={command.error} status={command.status} />}
    </div>
  )
}

export function CollectionBatches({ tenant, connections }: { tenant: string; connections: Connection[] }) {
  const [opened, setOpened] = useState(false),
    [selectedBatch, setSelectedBatch] = useState("")
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="font-semibold">Borderôs de cobrança</h2>
      {!opened ? (
        <Button type="button" variant="outline" onClick={() => setOpened(true)}>
          Preparar ou consultar borderô
        </Button>
      ) : selectedBatch ? (
        <BatchDetail id={selectedBatch} tenant={tenant} connections={connections} back={() => setSelectedBatch("")} />
      ) : (
        <BatchList tenant={tenant} open={setSelectedBatch} />
      )}
    </section>
  )
}

function BatchList({ tenant, open }: { tenant: string; open: (s: string) => void }) {
  const [q, setQ] = useState(""),
    [offset, setOffset] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0)
  const [accountId, setAccountId] = useState(""),
    [reference, setReference] = useState(""),
    [items, setItems] = useState<Title[]>([])
  const resource = useResource<Result<List>>(
    root + "batches?" + new URLSearchParams({ q, offset: String(offset), historyOffset: String(historyOffset) }),
  )
  const result = resource.value?.tenantId === tenant ? resource.value : null,
    command = useCommand()
  const frozen = command.busy || command.uncertain
  async function prepare() {
    const response = await command.send<Result<{ id: string }>>(
      root + "prepare-batch",
      tenant,
      { accountId, reference, items: items.map(({ id, cents, dueOn }) => ({ id, cents, dueOn })) },
      "",
      "POST",
      (v) => v.tenantId === tenant && Boolean(v.data?.id),
    )
    if (response) open(response.data.id)
  }
  return (
    <div className="space-y-3">
      <p>
        Prepare títulos de vários clientes para a mesma conta. Cada título conserva seu valor e vencimento e recebe sua
        própria cobrança.
      </p>
      <label className="block">
        Localizar título ou cliente
        <Input
          value={q}
          disabled={frozen}
          onChange={(e) => {
            setQ(e.target.value)
            setOffset(0)
          }}
        />
      </label>
      {resource.error && <RequestError message={resource.error} status={resource.status} />}
      {resource.loading && <p role="status">Consultando títulos e borderôs…</p>}
      {result && (
        <>
          {result.canEdit && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void prepare()
              }}
            >
              <fieldset disabled={frozen} className="space-y-2">
                <label className="block">
                  Conta do borderô
                  <select
                    required
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="ml-2 rounded border p-2"
                  >
                    <option value="">Selecione a conta</option>
                    {result.data.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  Referência do borderô
                  <Input required maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
                </label>
                {result.data.candidates.map((i) => (
                  <label className="flex gap-2" key={i.id}>
                    <input
                      type="checkbox"
                      checked={items.some((s) => s.id === i.id)}
                      onChange={(e) => setItems(e.target.checked ? [...items, i] : items.filter((s) => s.id !== i.id))}
                    />
                    {i.name} • {dateLabel(i.dueOn)} • {brl(i.cents)} • {i.id}
                  </label>
                ))}
                {!result.data.candidates.length && <p>Nenhum título disponível neste filtro.</p>}
                <Button type="button" variant="outline" disabled={!offset} onClick={() => setOffset(offset - 30)}>
                  Títulos anteriores
                </Button>{" "}
                <Button
                  type="button"
                  variant="outline"
                  disabled={!result.data.more}
                  onClick={() => setOffset(offset + 30)}
                >
                  Próximos títulos
                </Button>
              </fieldset>
              <p>
                {items.length} título(s) selecionado(s) •{" "}
                {brl(items.reduce((a, i) => a + BigInt(i.cents), BigInt(0)).toString())}
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={frozen}
                onClick={() => {
                  setItems([])
                  resource.reload()
                }}
              >
                Atualizar títulos e limpar seleção
              </Button>{" "}
              <Button type="submit" disabled={command.busy || !items.length}>
                {command.uncertain ? "Consultar preparação" : "Preparar borderô"}
              </Button>
            </form>
          )}
          <h3 className="font-medium">Histórico de borderôs</h3>
          {result.data.history.map((b) => (
            <p key={b.id}>
              <Button type="button" variant="outline" disabled={frozen} onClick={() => open(b.id)}>
                {b.reference}
              </Button>{" "}
              {b.accountName} • {time(b.createdAt)} • {b.count} título(s) • {brl(b.cents)}
              {b.cancelledAt && " • Cancelado"}
            </p>
          ))}
          {!result.data.history.length && <p>Nenhum borderô registrado.</p>}
          <Button
            type="button"
            variant="outline"
            disabled={frozen || !historyOffset}
            onClick={() => setHistoryOffset(historyOffset - 20)}
          >
            Borderôs anteriores
          </Button>{" "}
          <Button
            type="button"
            variant="outline"
            disabled={frozen || !result.data.moreHistory}
            onClick={() => setHistoryOffset(historyOffset + 20)}
          >
            Próximos borderôs
          </Button>
        </>
      )}
      {command.error && <RequestError message={command.error} status={command.status} />}
    </div>
  )
}
