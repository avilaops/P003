"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { normalizeDecimal } from "@/lib/decimal-input"
import type { SettingsData, WalletSettings } from "../wallet-controls"

const inputClass = "block h-10 w-full rounded-md border bg-background px-2"
const natureFields = [
  ["salesCategoryId", "Vendas", "income"],
  ["purchasesCategoryId", "Compras", "expense"],
  ["payrollCategoryId", "Pessoal", "expense"],
] as const
const rates = [
  ["interestMonthlyBps", "Juros ao mês (%)"],
  ["penaltyBps", "Multa (%)"],
  ["discountLimitBps", "Desconto sem aprovação (%)"],
] as const
type Center = { id: string; code: string; name: string; revision: number; status: string }
export function WalletSettingsPanel() {
  const resource = useResource<WalletSettings>("/api/erp/financial-wallet-settings")
  const centers = useResource<{ tenantId: string; canEdit: boolean; data: Center[] }>("/api/erp/financial-cost-centers")
  const [selected, setSelected] = useState("")
  const center = centers.value?.data.find((c) => c.id === selected)
  const settingsCommand = useCommand(),
    centerCommand = useCommand()
  const [notice, setNotice] = useState("")
  const value = resource.value
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Naturezas, centros de custo e alçadas</h2>
      {notice && <p role="status">{notice}</p>}
      {resource.error && <p role="alert">{resource.error}</p>}
      {value && (
        <form
          key={value.revision}
          className="form-section space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            const fields = new FormData(e.currentTarget),
              payload: SettingsData = { ...value.data }
            for (const [key] of natureFields) payload[key] = String(fields.get(key) || "") || null
            for (const [key] of rates)
              payload[key] = Number(normalizeDecimal(String(fields.get(key)))?.replace(".", ""))
            payload.defaultCostCenterId = String(fields.get("defaultCostCenterId") || "") || null
            payload.requireCostCenter = fields.has("requireCostCenter")
            payload.graceDays = Number(fields.get("graceDays"))
            payload.restructureApprovalLimit = fields.get("restructureApprovalLimit")
              ? normalizeDecimal(String(fields.get("restructureApprovalLimit")))
              : null
            payload.paymentApprovalLimit = fields.get("paymentApprovalLimit")
              ? normalizeDecimal(String(fields.get("paymentApprovalLimit")))
              : null
            if (
              await settingsCommand.send(
                "/api/erp/financial-wallet-settings",
                value.tenantId,
                payload,
                resource.etag,
                "PUT",
              )
            ) {
              setNotice("Parâmetros financeiros salvos.")
              resource.reload()
            }
          }}
        >
          <fieldset
            className="grid gap-3 sm:grid-cols-3"
            disabled={!value.canEdit || settingsCommand.busy || settingsCommand.uncertain || settingsCommand.stale}
          >
            {natureFields.map(([key, label, direction]) => (
              <label key={key}>
                Natureza • {label}
                <select className={inputClass} name={key} defaultValue={value.data[key] || ""}>
                  <option value="">Padrão da origem</option>
                  {value.categories
                    .filter((c) => c.direction === direction)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code} • {c.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            <label>
              Centro padrão
              <select
                className={inputClass}
                name="defaultCostCenterId"
                defaultValue={value.data.defaultCostCenterId || ""}
              >
                <option value="">Sem padrão</option>
                {value.costCenters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} • {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="requireCostCenter" defaultChecked={value.data.requireCostCenter} />
              Exigir centro de custo
            </label>
            {rates.map(([key, label]) => (
              <label key={key}>
                {label}
                <Input
                  required
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  name={key}
                  defaultValue={value.data[key] / 100}
                />
              </label>
            ))}
            <label>
              Carência (dias)
              <Input required type="number" min="0" max="365" name="graceDays" defaultValue={value.data.graceDays} />
            </label>
            <label>
              Renegociação sem aprovação até (R$)
              <Input
                name="restructureApprovalLimit"
                defaultValue={value.data.restructureApprovalLimit ?? ""}
                placeholder="Sem limite"
                inputMode="decimal"
                pattern="(0|[1-9][0-9]{0,11})([.,][0-9]{1,2})?"
              />
            </label>
            <label>
              Pagamento sem aprovação até (R$)
              <Input
                name="paymentApprovalLimit"
                defaultValue={value.data.paymentApprovalLimit ?? ""}
                placeholder="Sem limite"
                inputMode="decimal"
                pattern="(0|[1-9][0-9]{0,11})([.,][0-9]{1,2})?"
              />
            </label>
          </fieldset>
          {settingsCommand.error && <p role="alert">{settingsCommand.error}</p>}
          {value.canEdit && (
            <Button type="submit" disabled={settingsCommand.busy || settingsCommand.stale}>
              {settingsCommand.uncertain ? "Repetir confirmação" : "Salvar parâmetros das carteiras"}
            </Button>
          )}
          {settingsCommand.stale && (
            <Button
              type="button"
              onClick={() => {
                settingsCommand.reset()
                resource.reload()
              }}
            >
              Recarregar parâmetros
            </Button>
          )}
        </form>
      )}
      <h3 className="font-semibold">Centros de custo</h3>
      {centers.error && <p role="alert">{centers.error}</p>}
      {centers.value && (
        <>
          <label>
            Consultar centro
            <select
              className={inputClass}
              value={selected}
              onChange={(e) => {
                centerCommand.reset()
                setSelected(e.target.value)
              }}
              disabled={centerCommand.busy || centerCommand.uncertain}
            >
              <option value="">Novo centro</option>
              {centers.value.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} • {c.name}
                </option>
              ))}
            </select>
          </label>
          <form
            key={center?.id + ":" + center?.revision}
            className="form-section space-y-3"
            onSubmit={async (e) => {
              e.preventDefault()
              const s = new FormData(e.currentTarget),
                payload = { code: String(s.get("code")), name: String(s.get("name")), status: String(s.get("status")) }
              const saved = await centerCommand.send<{ data: Center }>(
                "/api/erp/financial-cost-centers" + (center ? "/" + center.id : ""),
                centers.value!.tenantId,
                payload,
                center ? `"${center.revision}"` : "",
                center ? "PUT" : "POST",
              )
              if (saved) {
                setSelected(saved.data.id)
                setNotice("Centro de custo salvo.")
                centers.reload()
                resource.reload()
              }
            }}
          >
            <fieldset
              className="grid gap-3 sm:grid-cols-3"
              disabled={!centers.value.canEdit || centerCommand.busy || centerCommand.uncertain || centerCommand.stale}
            >
              <label>
                Código
                <Input name="code" required maxLength={40} defaultValue={center?.code} />
              </label>
              <label>
                Nome
                <Input name="name" required maxLength={200} defaultValue={center?.name} />
              </label>
              <label>
                Situação
                <select name="status" className={inputClass} defaultValue={center?.status ?? "active"}>
                  <option value="active">Ativo</option>
                  <option value="archived">Arquivado</option>
                </select>
              </label>
            </fieldset>
            {centerCommand.error && <p role="alert">{centerCommand.error}</p>}
            {centers.value.canEdit && (
              <Button type="submit" disabled={centerCommand.stale || centerCommand.busy}>
                {centerCommand.uncertain ? "Repetir confirmação" : "Salvar centro de custo"}
              </Button>
            )}
            {centerCommand.stale && (
              <Button
                type="button"
                onClick={() => {
                  centerCommand.reset()
                  centers.reload()
                }}
              >
                Recarregar centros
              </Button>
            )}
          </form>
        </>
      )}
    </section>
  )
}
