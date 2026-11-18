"use client"

import Link from "next/link"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useCommand, useResource } from "@/hooks/use-operation"
import { decimalPattern, normalizeDecimal } from "@/lib/decimal-input"

export type WalletName = "receivables" | "financial-payables"
type Choice = { id: string; code: string; name: string; direction?: string }
export type SettingsData = {
  salesCategoryId: string | null
  purchasesCategoryId: string | null
  payrollCategoryId: string | null
  defaultCostCenterId: string | null
  requireCostCenter: boolean
  interestMonthlyBps: number
  penaltyBps: number
  graceDays: number
  discountLimitBps: number
  paymentApprovalLimit: string | null
  restructureApprovalLimit?: string | null
}
export type WalletSettings = {
  tenantId: string
  revision: number
  canEdit: boolean
  categories: Choice[]
  costCenters: Choice[]
  data: SettingsData
}
type Allocation = { costCenterId: string; name?: string; basisPoints: number }
export type Classification = {
  costCenterAllocations?: Allocation[]
  natureId?: string | null
  costCenterId?: string | null
  forecastAccountId?: string | null
  competenceOn?: string
}
export function PartnerStatementLink({ title }: { title: { id: string } }) {
  const party = (title as { partyId?: string | null }).partyId
  return party ? (
    <Link href={"/financeiro/ficha-financeira?partyId=" + party} className="font-medium text-primary underline">
      Ficha financeira do parceiro
    </Link>
  ) : null
}
const select = "block w-full min-w-0 rounded-md border bg-background p-2 text-sm"
const chargeFields = [
  ["interestAmount", "Juros"],
  ["penaltyAmount", "Multa"],
  ["surchargeAmount", "Acréscimos"],
  ["discountAmount", "Desconto"],
] as const
type ChargeKey = (typeof chargeFields)[number][0]
export type Charges = Partial<Record<ChargeKey, string>>
export function useWalletCalculation(amount: string, date: string, due: string, wallet: WalletName) {
  const settings = useResource<WalletSettings>("/api/erp/financial-wallet-settings")
  const [charges, setCharges] = useState<Charges>({})
  const [natureId, setNature] = useState(""),
    [costCenterId, setCenter] = useState("")
  const principal = BigInt((normalizeDecimal(amount) || "0.00").replace(".", "")),
    s = settings.value?.data
  const days = BigInt(
    Math.max(0, Math.floor((Date.parse(date) - Date.parse(due)) / 86400000) - (s?.graceDays ?? 0)) || 0,
  )
  const automatic = {
    interestAmount: (principal * BigInt(s?.interestMonthlyBps ?? 0) * days + BigInt(150000)) / BigInt(300000),
    penaltyAmount: days ? (principal * BigInt(s?.penaltyBps ?? 0) + BigInt(5000)) / BigInt(10000) : BigInt(0),
    surchargeAmount: BigInt(0),
    discountAmount: BigInt(0),
  }
  const amountOf = (key: ChargeKey) =>
    charges[key]?.trim() ? BigInt((normalizeDecimal(charges[key]!) ?? "0.00").replace(".", "")) : automatic[key]
  const net =
    principal +
    amountOf("interestAmount") +
    amountOf("penaltyAmount") +
    amountOf("surchargeAmount") -
    amountOf("discountAmount")
  const requiresApproval = Boolean(
    s &&
      (amountOf("discountAmount") * BigInt(10000) > principal * BigInt(s.discountLimitBps) ||
        (wallet === "financial-payables" &&
          s.paymentApprovalLimit !== null &&
          net > BigInt(s.paymentApprovalLimit.replace(".", "")))),
  )
  const data = Object.fromEntries(
    chargeFields.filter(([key]) => charges[key]?.trim()).map(([key]) => [key, normalizeDecimal(charges[key]!)]),
  )
  return {
    charges,
    setCharges,
    automatic,
    net,
    requiresApproval,
    data: { ...data, ...(natureId ? { natureId } : {}), ...(costCenterId ? { costCenterId } : {}) },
    natureId,
    setNature,
    costCenterId,
    setCenter,
    categories:
      settings.value?.categories.filter((c) => c.direction === (wallet === "receivables" ? "income" : "expense")) ?? [],
    centers: settings.value?.costCenters ?? [],
  }
}
const money = (cents: bigint) =>
  `${cents < BigInt(0) ? "−" : ""}R$ ${(cents < BigInt(0) ? -cents : cents) / BigInt(100)},${((cents < BigInt(0) ? -cents : cents) % BigInt(100)).toString().padStart(2, "0")}`
export function ChargeFields({
  calculation,
  title,
}: {
  calculation: ReturnType<typeof useWalletCalculation>
  title?: { id: string } & Classification
}) {
  return (
    <>
      {chargeFields.map(([key, label]) => (
        <label className="space-y-1" key={key}>
          {label}
          <Input
            inputMode="decimal"
            maxLength={15}
            pattern={decimalPattern(2)}
            placeholder={money(calculation.automatic[key]).replace("R$ ", "")}
            value={calculation.charges[key] ?? ""}
            onChange={(e) => calculation.setCharges({ ...calculation.charges, [key]: e.target.value })}
          />
        </label>
      ))}
      <label>
        Natureza da baixa
        <select className={select} value={calculation.natureId} onChange={(e) => calculation.setNature(e.target.value)}>
          <option value="">Usar natureza do título</option>
          {calculation.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} • {c.name}
            </option>
          ))}
        </select>
      </label>
      {title?.costCenterAllocations?.length ? (
        <p>
          Rateio do título •{" "}
          {title.costCenterAllocations
            .map((c) => `${c.name} ${(c.basisPoints / 100).toLocaleString("pt-BR")}%`)
            .join(" • ")}
        </p>
      ) : (
        <label>
          Centro de custo da baixa
          <select
            className={select}
            value={calculation.costCenterId}
            onChange={(e) => calculation.setCenter(e.target.value)}
          >
            <option value="">Usar centro do título</option>
            {calculation.centers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} • {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="sm:col-span-2 font-semibold" aria-live="polite">
        Valor líquido • {money(calculation.net)}
      </p>
    </>
  )
}
export function PaymentAmounts({
  payment,
}: {
  payment: {
    amount: string
    costCenterAllocations?: (Allocation & { amount: string; netAmount: string })[]
    proofPath?: string | null
    proofName?: string | null
  } & Partial<Record<ChargeKey | "netAmount" | "financialEffect", string>>
}) {
  if (!payment.netAmount) return null
  return (
    <div className="text-sm">
      <p>
        Principal • R$ {payment.amount.replace(".", ",")}
        {chargeFields
          .filter(([key]) => payment[key] && payment[key] !== "0.00")
          .map(([key, label]) => (
            <span key={key}>
              {" "}
              • {label} R$ {payment[key]!.replace(".", ",")}
            </span>
          ))}{" "}
        • Líquido R$ {payment.netAmount.replace(".", ",")}
      </p>
      {Boolean(payment.costCenterAllocations?.length) && (
        <ul aria-label="Rateio da baixa">
          {payment.costCenterAllocations!.map((c) => (
            <li key={c.costCenterId}>
              {c.name} • {(c.basisPoints / 100).toLocaleString("pt-BR")}% • Principal R$ {c.amount.replace(".", ",")} •
              Líquido R$ {c.netAmount.replace(".", ",")}
            </li>
          ))}
        </ul>
      )}
      {payment.proofPath && (
        <a className="font-medium text-primary underline" href={payment.proofPath} download>
          {payment.proofName}
        </a>
      )}
      {payment.financialEffect === "unclassified" && <p>Baixa histórica • conta pendente de classificação</p>}
      {payment.financialEffect === "non_cash" && <p>Baixa sem movimento de caixa</p>}
    </div>
  )
}
export function WalletClassification({
  wallet,
  title,
  tenantId,
  etag,
  canEdit,
  reload,
}: {
  wallet: WalletName
  title: Classification & { id: string; dueDate: string }
  tenantId: string
  etag: string
  canEdit: boolean
  reload: () => void
}) {
  const settings = useResource<WalletSettings>("/api/erp/financial-wallet-settings")
  const command = useCommand()
  const [split, setSplit] = useState(Boolean(title.costCenterAllocations?.length))
  const [percents, setPercents] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (title.costCenterAllocations ?? []).map((c) => [
        c.costCenterId,
        (c.basisPoints / 100).toFixed(2).replace(".", ","),
      ]),
    ),
  )
  const [splitError, setSplitError] = useState("")
  const accounts = useResource<{ data: Choice[] }>("/api/erp/financial-accounts?status=active&limit=100")
  if (settings.error) return <p role="alert">{settings.error}</p>
  if (!settings.value) return null
  const choices = settings.value.categories.filter(
    (c) => c.direction === (wallet === "receivables" ? "income" : "expense"),
  )
  return (
    <details>
      <summary className="cursor-pointer font-medium">Classificação do título</summary>
      <form
        className="mt-2 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          const data = new FormData(e.currentTarget)
          const allocations = split
            ? Object.entries(percents)
                .filter(([, v]) => v.trim())
                .map(([costCenterId, v]) => ({
                  costCenterId,
                  basisPoints: Number((normalizeDecimal(v) ?? "0").replace(".", "")),
                }))
            : []
          if (
            split &&
            (allocations.length < 2 ||
              allocations.some((c) => !c.basisPoints) ||
              allocations.reduce((sum, c) => sum + c.basisPoints, 0) !== 10000)
          ) {
            setSplitError("Informe ao menos dois centros e distribua 100% do título.")
            return
          }
          setSplitError("")
          if (
            await command.send(
              "/api/erp/" + wallet + "/" + title.id + "/classification",
              tenantId,
              {
                natureId: data.get("nature"),
                costCenterId: split ? null : data.get("center") || null,
                costCenterAllocations: allocations,
                competenceOn: data.get("competence"),
                forecastAccountId: data.get("forecastAccount") || null,
              },
              etag,
              "PUT",
            )
          )
            reload()
        }}
      >
        <fieldset
          disabled={!canEdit || command.busy || command.uncertain || command.stale}
          className="grid gap-3 sm:grid-cols-3"
        >
          <label>
            Natureza financeira
            <select className={select} required name="nature" defaultValue={title.natureId ?? ""}>
              <option value="">Selecione</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} • {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={split}
              onChange={(e) => {
                setSplit(e.target.checked)
                setSplitError("")
              }}
            />
            Ratear entre centros de custo
          </label>
          {split ? (
            <div className="sm:col-span-3 grid gap-2 sm:grid-cols-3">
              {settings.value.costCenters.map((c) => (
                <label key={c.id}>
                  Percentual de {c.name} (%)
                  <Input
                    inputMode="decimal"
                    maxLength={6}
                    pattern={decimalPattern(2)}
                    value={percents[c.id] ?? ""}
                    onChange={(e) => setPercents((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                </label>
              ))}
              {title.costCenterAllocations
                ?.filter((c) => !settings.value!.costCenters.some((a) => a.id === c.costCenterId))
                .map((c) => (
                  <p key={c.costCenterId}>
                    {c.name} • Centro arquivado{" "}
                    <Button type="button" onClick={() => setPercents((prev) => ({ ...prev, [c.costCenterId]: "" }))}>
                      Retirar do rateio
                    </Button>
                  </p>
                ))}
            </div>
          ) : (
            <label>
              Centro de custo
              <select
                className={select}
                required={settings.value.data.requireCostCenter}
                name="center"
                defaultValue={title.costCenterId ?? ""}
              >
                <option value="">Sem centro</option>
                {settings.value.costCenters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} • {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Conta prevista
            <select className={select} name="forecastAccount" defaultValue={title.forecastAccountId ?? ""}>
              <option value="">Sem conta prevista</option>
              {accounts.value?.data.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} • {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Competência
            <Input required type="date" name="competence" defaultValue={title.competenceOn ?? title.dueDate} />
          </label>
        </fieldset>
        {splitError && <p role="alert">{splitError}</p>}
        {command.error && <p role="alert">{command.error}</p>}
        {canEdit && (
          <Button type="submit" variant="outline" disabled={command.busy || command.stale}>
            {command.uncertain ? "Repetir confirmação" : "Salvar classificação"}
          </Button>
        )}
        {command.stale && (
          <Button type="button" onClick={reload}>
            Recarregar título
          </Button>
        )}
      </form>
    </details>
  )
}
type Approval = {
  id: string
  status: string
  titleRevision: string
  requestedBy: string
  decidedBy: string | null
  reason: string | null
  canDecide: boolean
  intent: Record<string, string | null | object>
  reasons: string[]
}
function approvalAmounts(intent: Approval["intent"]) {
  const amount = String(intent.amount),
    parts = Object.fromEntries(chargeFields.map(([key]) => [key, String(intent[key] ?? "0.00")]))
  const net = chargeFields.reduce(
    (total, [key]) =>
      total + BigInt(parts[key]!.replace(".", "")) * (key === "discountAmount" ? -BigInt(1) : BigInt(1)),
    BigInt(amount.replace(".", "")),
  )
  return { amount, ...parts, netAmount: `${net / BigInt(100)}.${(net % BigInt(100)).toString().padStart(2, "0")}` }
}
const statuses: Record<string, string> = {
  pending: "Pendente",
  approved: "Aprovado",
  rejected: "Recusado",
  used: "Baixado",
}
export function WalletApprovals({
  wallet,
  id,
  tenantId,
  etag,
  canEdit,
  reload,
}: {
  wallet: WalletName
  id: string
  tenantId: string
  etag: string
  canEdit: boolean
  reload: () => void
}) {
  const base = "/api/erp/" + wallet + "/" + id,
    approvals = useResource<{ data: Approval[] }>(base + "/approvals"),
    command = useCommand()
  const [reason, setReason] = useState("")
  if (!approvals.value?.data.length) return approvals.error ? <p role="alert">{approvals.error}</p> : null
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">Aprovações da baixa</h3>
      {approvals.value.data.map((row) => (
        <article className="space-y-2 rounded-md border p-3" key={row.id}>
          <p>
            {statuses[row.status]} • {row.requestedBy} • R$ {String(row.intent.amount)} de principal
          </p>
          <p className="text-sm">
            {row.reasons.includes("discount") ? "Desconto acima do limite" : ""}{" "}
            {row.reasons.includes("payment") ? "Pagamento acima da alçada" : ""} • {String(row.intent.reference)} •{" "}
            {String(row.intent.occurredOn)}
          </p>
          <PaymentAmounts payment={approvalAmounts(row.intent)} />
          {row.decidedBy && (
            <p>
              {row.decidedBy} • {row.reason}
            </p>
          )}
          {row.canDecide && etag === `"${row.titleRevision}"` && (
            <>
              <label>
                Justificativa
                <Input value={reason} minLength={3} onChange={(e) => setReason(e.target.value)} />
              </label>
              {(["approved", "rejected"] as const).map((decision) => (
                <Button
                  key={decision}
                  variant="outline"
                  disabled={reason.trim().length < 3 || command.busy}
                  onClick={async () => {
                    if (
                      await command.send(
                        base + "/approvals/" + row.id + "/decision",
                        tenantId,
                        { decision, reason },
                        etag,
                      )
                    ) {
                      setReason("")
                      approvals.reload()
                    }
                  }}
                >
                  {decision === "approved" ? "Aprovar" : "Recusar"}
                </Button>
              ))}
            </>
          )}
          {canEdit && row.status === "approved" && etag === `"${row.titleRevision}"` && (
            <form
              onSubmit={async (event) => {
                event.preventDefault()
                const payload = { ...row.intent, approvalId: row.id }
                if (row.intent.supportingDocument) {
                  const file = new FormData(event.currentTarget).get("proof")
                  if (!(file instanceof File)) return
                  const { supportingDocument } = await import("./supporting-documents")
                  const original = row.intent.supportingDocument as { description: string; documentDate: string }
                  Object.assign(payload, {
                    supportingDocument: await supportingDocument(file, original.description, original.documentDate),
                  })
                }
                if (await command.send(base + "/payments", tenantId, payload, etag)) reload()
              }}
            >
              {Boolean(row.intent.supportingDocument) && (
                <label>
                  Comprovante original
                  <Input name="proof" type="file" required accept="application/pdf,image/png,image/jpeg" />
                </label>
              )}
              <Button type="submit" disabled={command.busy}>
                Confirmar baixa aprovada
              </Button>
            </form>
          )}
        </article>
      ))}
      {command.error && <p role="alert">{command.error}</p>}
    </section>
  )
}
