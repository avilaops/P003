"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RequestError } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"
import { brl, readBankFile } from "./treasury-reconciliation"

type Option = { id: string; name: string; partyId: string; cents: string; dueOn: string }
type Charge = {
  id: string
  accountId: string
  groupId: string | null
  name: string
  method: "PIX" | "BOLETO"
  state: string
  dueOn: string
  cents: string
  providerId: string | null
  reviewReason: string | null
  instructions: { barcode?: string; qrCode?: string; ticketUrl?: string } | null
  receivableIds: string[]
}
type Data = {
  tenantId: string
  canEdit: boolean
  data: {
    options: Option[]
    charges: Charge[]
    accounts: { id: string; name: string; live: boolean }[]
    accountId: string | null
  }
}
const stateNames: Record<string, string> = {
  prepared: "Reservada para emissão",
  issued: "Emitida",
  paid: "Liquidada",
  review: "Conferência",
  outside_scope: "Outra operação",
  unknown_charge: "Cobrança desconhecida",
  divergent: "Divergência com o provedor",
}
type Group = {
  id: string
  kind: string
  dueOn: string
  reversedOn?: string | null
  items: { id: string; side: string; amount: string }[]
}
export function CollectionWorkspace({ groupId = "", partyId = "" }: { groupId?: string; partyId?: string }) {
  return groupId ? <GroupedCollection groupId={groupId} partyId={partyId} /> : <Collections />
}
function GroupedCollection({ groupId, partyId }: { groupId: string; partyId: string }) {
  const history = useResource<{ tenantId: string; data: Group[] }>(
    "/api/erp/finance/operations?partyId=" + encodeURIComponent(partyId),
  )
  if (history.loading) return <p role="status">Consultando agrupamento…</p>
  if (history.error) return <RequestError message={history.error} status={history.status} />
  const group = history.value?.data.find((g) => g.id === groupId && g.kind === "billing_group" && !g.reversedOn)
  if (!group || !history.value) return <p role="alert">Agrupamento não encontrado para este cliente.</p>
  return <Collections group={group} groupTenant={history.value.tenantId} />
}
function Collections({ group, groupTenant }: { group?: Group; groupTenant?: string }) {
  const resource = useResource<Data>("/api/erp/finance-treasury/collections" + (group ? "?groupId=" + group.id : "")),
    command = useCommand()
  const [ids, setIds] = useState<string[]>([]),
    [method, setMethod] = useState("PIX"),
    [file, setFile] = useState<File | null>(null),
    [notice, setNotice] = useState("")
  const [chosen, setChosen] = useState("")
  const disabled = command.busy || command.uncertain || command.stale
  const snapshot = resource.value,
    bank = snapshot?.data
  const selected = bank?.accounts.find((a) => a.id === (chosen || bank.accountId))
  const selectedIds = group ? group.items.filter((i) => i.side === "receivable").map((i) => i.id) : ids
  const charges = bank?.charges.filter((c) => !group || c.groupId === group.id) ?? []
  async function send(path: string, body: object) {
    if (!snapshot) return
    const response = await command.send<{
      tenantId: string
      data: { state?: string; outcomes?: { id: string; state: string }[] }
    }>(`/api/erp/finance-treasury/${path}`, snapshot.tenantId, body)
    if (response?.tenantId === snapshot.tenantId) {
      setNotice(
        response.data.outcomes
          ? response.data.outcomes.map((o) => o.id + " • " + (stateNames[o.state] ?? o.state)).join("\n") ||
              "Arquivo sem operações."
          : (stateNames[response.data.state ?? ""] ?? "Operação registrada."),
      )
      setIds([])
      resource.reload()
    }
  }
  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-7">
      <h1 className="text-2xl font-semibold">Cobranças e retornos</h1>
      {resource.error && <RequestError message={resource.error} status={resource.status} />}
      {resource.loading && <p role="status">Consultando cobranças…</p>}
      {snapshot && bank && (!groupTenant || groupTenant === snapshot.tenantId) && (
        <>
          {group && (
            <section className="space-y-2 rounded-xl border p-4">
              <h2 className="font-semibold">Agrupamento de cobrança</h2>
              <p>Vencimento • {group.dueOn}</p>
              {group.items.map((i) => (
                <p className="text-sm" key={i.id}>
                  Título {i.id} • R$ {i.amount.replace(".", ",")}
                </p>
              ))}
            </section>
          )}
          <section className="space-y-3 rounded-xl border p-4">
            <h2 className="font-semibold">Mercado Pago</h2>
            {!bank.accounts.length && (
              <p role="status">A empresa ainda precisa vincular uma conta financeira e as credenciais do vendedor.</p>
            )}
            {!!bank.accounts.length && (
              <label className="grid max-w-sm gap-1 text-sm">
                Conta de cobrança
                <select
                  disabled={disabled}
                  className="h-9 rounded-md border bg-background px-2"
                  value={selected?.id || ""}
                  onChange={(e) => setChosen(e.target.value)}
                >
                  <option value="">Selecione a conta</option>
                  {bank.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} • {a.live ? "Produção" : "Homologação"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selected && snapshot.canEdit && (
              <>
                <label className="grid max-w-sm gap-1 text-sm">
                  Meio de cobrança
                  <select
                    className="h-9 rounded-md border bg-background px-2"
                    disabled={disabled}
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                  >
                    <option value="PIX">Pix</option>
                    <option value="BOLETO">Boleto</option>
                  </select>
                </label>
                {!group && (
                  <fieldset disabled={disabled} className="space-y-1">
                    <legend className="mb-2 font-medium">Títulos em aberto</legend>
                    {bank.options.map((r) => (
                      <label className="flex gap-2 text-sm" key={r.id}>
                        <input
                          type="checkbox"
                          checked={ids.includes(r.id)}
                          onChange={(e) => setIds(e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id))}
                        />
                        {r.name} • {r.dueOn} • {brl(r.cents)}
                      </label>
                    ))}
                  </fieldset>
                )}
                {(!group || !charges.length) && (
                  <Button
                    disabled={disabled || !selectedIds.length}
                    onClick={() =>
                      send("issue-charge", {
                        accountId: selected.id,
                        billingType: method,
                        receivableIds: selectedIds,
                        ...(group ? { groupId: group.id } : {}),
                      })
                    }
                  >
                    {selected.live ? "Emitir cobrança" : "Emitir cobrança de teste"}
                  </Button>
                )}
                <form
                  className="flex flex-wrap items-end gap-2 border-t pt-4"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (file)
                      try {
                        await send("import-return", { accountId: selected.id, content: await readBankFile(file) })
                      } catch (err) {
                        setNotice(String(err))
                      }
                  }}
                >
                  <label className="grid gap-1 text-sm">
                    Relatório Dinheiro em conta • CSV
                    <Input
                      type="file"
                      accept=".csv,text/csv"
                      required
                      disabled={disabled}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <Button type="submit" variant="outline" disabled={!file || disabled}>
                    Conferir retorno
                  </Button>
                </form>
              </>
            )}
          </section>
          <section className="space-y-3">
            <h2 className="font-semibold">Histórico de cobrança</h2>
            {!charges.length && <p>Nenhuma cobrança registrada.</p>}
            {charges.map((c) => (
              <article key={c.id} className="space-y-2 rounded-xl border p-4">
                <strong>
                  {c.name} • {brl(c.cents)}
                </strong>
                <p>
                  {c.method === "PIX" ? "Pix" : "Boleto"} • {c.dueOn} • {stateNames[c.state]}
                </p>
                <p className="text-sm text-muted-foreground">
                  {c.providerId ?? c.id} • {c.receivableIds.length} título(s)
                </p>
                {c.reviewReason && <p>{c.reviewReason}</p>}
                {c.instructions?.qrCode && (
                  <label className="grid gap-1 text-sm">
                    Pix copia e cola
                    <Input readOnly value={c.instructions.qrCode} />
                  </label>
                )}
                {c.instructions?.barcode && <p className="break-all">{c.instructions.barcode}</p>}
                {c.instructions?.ticketUrl && (
                  <a href={c.instructions.ticketUrl} className="underline" target="_blank" rel="noreferrer">
                    Abrir boleto
                  </a>
                )}
                {c.state === "prepared" && snapshot.canEdit && (
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      send("issue-charge", {
                        accountId: c.accountId,
                        billingType: c.method,
                        groupId: c.groupId,
                        receivableIds: c.receivableIds,
                      })
                    }
                  >
                    Conferir emissão
                  </Button>
                )}
              </article>
            ))}
          </section>
        </>
      )}
      {notice && (
        <pre className="whitespace-pre-wrap text-sm" role="status">
          {notice}
        </pre>
      )}
      {command.error && <RequestError message={command.error} status={command.status} />}
      {command.uncertain && (
        <Button disabled={command.busy} onClick={() => send("", {})}>
          Conferir última operação
        </Button>
      )}
    </main>
  )
}
