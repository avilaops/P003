import { useState, type FormEvent } from "react"
import { RequestError } from "@/components/feedback/session-recovery"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { erpFetch } from "@/lib/api/client"
import { dateLabel, reaisFromCents } from "./finance-insights-model"
import { readBankFile } from "./treasury-reconciliation"
import styles from "./cnab-collection.module.css"

const root = "/api/erp/finance-treasury/"
export const cnabStateNames: Record<string, string> = {
  remitted: "Remessa gerada",
  registered: "Entrada confirmada",
  rejected: "Entrada rejeitada",
  paid: "Liquidado",
  review: "Em conferência",
  unknown: "Título desconhecido",
  duplicate: "Ocorrência já processada",
  reversed: "Baixa estornada",
}
type Agreement = {
  id: string
  accountId: string
  name: string
  taxId: string
  transmissionCode: string
  beneficiaryCode: string
  agency: string
  agencyDigit: string
  account: string
  accountDigit: string
  interestMonthlyBps: number
  fineBps: number
  nextSequence: number
  nextOurNumber: string
}
type FileReceipt = {
  id: string
  filename: string
  sequence: number
  count: number
  sha256: string
  createdAt: string
  createdBy: string
}
type Remittance = FileReceipt & { batchId: string; cents: string }
type Review = {
  id: string
  state: string
  reason: string | null
  reviewReason: string
  createdAt: string
  createdBy: string
}
type ReviewResult = Review & { accountId: string; returnId: string; ordinal: number }
type BankReturn = FileReceipt & {
  outcomes: {
    ordinal: number
    ourNumber: string
    occurrence: string
    state: string
    reason: string | null
    receivableId: string | null
    nominalCents: string | null
    paidCents: string | null
    feeCents: string | null
    netCents: string | null
    occurredOn: string | null
    creditOn: string | null
    reviews: Review[]
  }[]
}
type ProfileData = {
  account: { name: string; bank: string | null; branch: string | null; accountNumber: string | null }
  company: { taxId: string | null; name: string }
  profile: Agreement | null
  canManage: boolean
  remittances: Remittance[]
  returns: BankReturn[]
  moreRemittances: boolean
  moreReturns: boolean
}
type Reply<T> = { tenantId: string; canEdit: boolean; data: T }
type Action = "cnab-profile" | "cnab-remittance" | "cnab-return" | "cnab-review"
const timestamp = (value: string) => new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
const percent = (bps: number) => (bps / 100).toLocaleString("pt-BR")
const codeFields = [
  ["transmissionCode", "Código de transmissão", 15],
  ["beneficiaryCode", "Código do beneficiário", 9],
  ["agency", "Agência", 4],
  ["agencyDigit", "Dígito da agência", 1],
  ["account", "Conta", 9],
  ["accountDigit", "Dígito da conta", 1],
] as const

function ProfileForm({
  data,
  disabled,
  save,
  close,
}: {
  data: ProfileData
  disabled: boolean
  save: (body: object) => void
  close: () => void
}) {
  const profile = data.profile
  const [beneficiaryCode, setBeneficiaryCode] = useState(profile?.beneficiaryCode ?? "")
  const showSeeds = !profile || beneficiaryCode !== profile.beneficiaryCode
  const agency = /^(\d{4})(?:-?(\d))?$/.exec(data.account.branch?.trim() ?? "")
  const account =
    /^(\d{1,9})-(\d)$/.exec(data.account.accountNumber?.trim() ?? "") ??
    /^(\d{9})(\d)$/.exec(data.account.accountNumber?.trim() ?? "")
  const defaults = {
    agency: agency?.[1],
    agencyDigit: agency?.[2],
    account: account?.[1]?.padStart(9, "0"),
    accountDigit: account?.[2],
    transmissionCode: "",
    beneficiaryCode: "",
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const { interest, fine, firstSequence, firstOurNumber, ...fields } = Object.fromEntries(form)
    save({
      ...fields,
      taxId: String(fields.taxId).toUpperCase(),
      interestMonthlyBps: Math.round(Number(interest) * 100),
      fineBps: Math.round(Number(fine) * 100),
      ...(firstSequence && { firstSequence: Number(firstSequence) }),
      ...(firstOurNumber && { firstOurNumber }),
    })
  }
  return (
    <form onSubmit={submit}>
      <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-2 font-medium">Convênio de cobrança simples registrada</legend>
        <label className="grid gap-1 text-sm">
          Nome do beneficiário
          <Input name="name" defaultValue={profile?.name ?? data.company.name.slice(0, 30)} maxLength={30} required />
        </label>
        <label className="grid gap-1 text-sm">
          CPF ou CNPJ do beneficiário
          <Input
            name="taxId"
            defaultValue={(profile?.taxId ?? data.company.taxId ?? "").replace(/[^\da-z]/gi, "")}
            pattern="([0-9]{11}|[A-Za-z0-9]{12}[0-9]{2})"
            maxLength={14}
            required
          />
        </label>
        {codeFields.map(([name, label, size]) => (
          <label key={name} className="grid gap-1 text-sm">
            {label} • {size} {size === 1 ? "dígito" : "dígitos"}
            <Input
              name={name}
              inputMode="numeric"
              defaultValue={profile?.[name] ?? defaults[name] ?? ""}
              onChange={name === "beneficiaryCode" ? (e) => setBeneficiaryCode(e.target.value) : undefined}
              pattern={"[0-9]{" + size + "}"}
              maxLength={size}
              required
            />
          </label>
        ))}
        <label className="grid gap-1 text-sm">
          Juros mensais após vencimento (%)
          <Input
            name="interest"
            type="number"
            min="0"
            max="100"
            step="0.01"
            defaultValue={(profile?.interestMonthlyBps ?? 0) / 100}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          Multa após vencimento (%)
          <Input
            name="fine"
            type="number"
            min="0"
            max="100"
            step="0.01"
            defaultValue={(profile?.fineBps ?? 0) / 100}
            required
          />
        </label>
        {showSeeds && (
          <>
            <label className="grid gap-1 text-sm">
              Sequência inicial da remessa
              <Input name="firstSequence" type="number" min="1" max="999999" defaultValue={profile ? "" : "1"} />
            </label>
            <label className="grid gap-1 text-sm">
              Primeiro nosso número • sem dígito
              <Input
                name="firstOurNumber"
                inputMode="numeric"
                pattern="0*[1-9][0-9]*"
                maxLength={12}
                defaultValue={profile ? "" : "1"}
              />
            </label>
          </>
        )}
        <div className={styles.actions}>
          <Button type="submit">Salvar convênio</Button>
          <Button type="button" variant="outline" onClick={close}>
            Fechar edição
          </Button>
        </div>
      </fieldset>
    </form>
  )
}

const outcomeFields = [
  ["nominalCents", "Valor nominal", reaisFromCents],
  ["paidCents", "Valor bruto pago", reaisFromCents],
  ["feeCents", "Tarifa bancária", reaisFromCents],
  ["netCents", "Valor líquido", reaisFromCents],
  ["occurredOn", "Data da ocorrência", dateLabel],
  ["creditOn", "Data do crédito", dateLabel],
] as const

function ReturnReceipt({
  file,
  expanded,
  disabled,
  review,
}: {
  file: BankReturn
  expanded: boolean
  disabled: boolean
  review?: (returnId: string, ordinal: number, reason: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(expanded)
  const [limit, setLimit] = useState(50)
  const [editing, setEditing] = useState<number | null>(null)
  return (
    <details open={expanded} onToggle={(e) => setOpen(e.currentTarget.open)} className="rounded-md border p-3">
      <summary className="cursor-pointer">
        {file.filename} • Sequência {file.sequence} • {file.count} ocorrência(s) • {timestamp(file.createdAt)}
      </summary>
      <p className="text-sm">Importado por {file.createdBy}</p>
      <p className="my-2 break-all text-xs text-muted-foreground">SHA-256 do texto importado • {file.sha256}</p>
      {open && (
        <ul className={styles.outcomes}>
          {file.outcomes.slice(0, limit).map((o, index) => (
            <li key={o.ordinal ?? index} className="text-sm">
              <strong>{cnabStateNames[o.state] ?? o.state}</strong> • Nosso número {o.ourNumber} • Ocorrência{" "}
              {o.occurrence}
              {o.reason && <p>{o.reason}</p>}
              {o.receivableId && <p className="break-all text-muted-foreground">Título {o.receivableId}</p>}
              <dl className={styles.values}>
                {outcomeFields.map(([key, label, format]) => {
                  const value = o[key]
                  return (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>{value ? format(value) : "Sem informação"}</dd>
                    </div>
                  )
                })}
              </dl>
              {o.reviews?.map((attempt) => (
                <div key={attempt.id} className={styles.attempt}>
                  <strong>Reavaliação • {cnabStateNames[attempt.state] ?? attempt.state}</strong>
                  <p>
                    {timestamp(attempt.createdAt)} • {attempt.createdBy}
                  </p>
                  <p>Motivo informado • {attempt.reviewReason}</p>
                  {attempt.reason && <p>Resultado • {attempt.reason}</p>}
                </div>
              ))}
              {review &&
                o.ordinal > 0 &&
                o.state === "review" &&
                !o.reviews?.some((attempt) => attempt.state !== "review") &&
                (editing === o.ordinal ? (
                  <form
                    className={styles.attempt}
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim()
                      if (await review(file.id, o.ordinal, reason)) setEditing(null)
                    }}
                  >
                    <label>
                      Motivo da reavaliação
                      <Input name="reason" minLength={3} maxLength={300} required disabled={disabled} />
                    </label>
                    <p>O ERP verificará a ocorrência original e poderá efetuar a baixa do título.</p>
                    <div className={styles.actions}>
                      <Button type="submit" disabled={disabled}>
                        Confirmar reavaliação
                      </Button>
                      <Button type="button" variant="outline" disabled={disabled} onClick={() => setEditing(null)}>
                        Cancelar reavaliação
                      </Button>
                    </div>
                  </form>
                ) : (
                  <Button type="button" variant="outline" disabled={disabled} onClick={() => setEditing(o.ordinal)}>
                    Reavaliar ocorrência
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {open && limit < file.outcomes.length && (
        <Button type="button" variant="outline" onClick={() => setLimit(limit + 50)}>
          Mostrar mais ocorrências
        </Button>
      )}
    </details>
  )
}

export function CnabCollection({
  tenant,
  accountId,
  batchId,
  reference,
  remitted,
  canGenerate,
  back,
  onChanged,
}: {
  tenant: string
  accountId: string
  batchId: string
  reference: string
  remitted: boolean
  canGenerate: boolean
  back: () => void
  onChanged: () => void
}) {
  const [offset, setOffset] = useState(0)
  const resource = useResource<Reply<ProfileData>>(
    root + "cnab-profile?" + new URLSearchParams({ accountId, offset: String(offset) }),
  )
  const command = useCommand()
  const [editing, setEditing] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [lastAction, setLastAction] = useState<Action>("cnab-profile")
  const [lastReturn, setLastReturn] = useState<BankReturn | null>(null)
  const [notice, setNotice] = useState("")
  const [fileError, setFileError] = useState("")
  const [fileBusy, setFileBusy] = useState(false)
  const result = resource.value?.tenantId === tenant ? resource.value : null
  const data = result?.data
  const returns = data?.returns ?? []
  const receipts =
    lastReturn && offset === 0 && !returns.some((r) => r.id === lastReturn.id) ? [lastReturn, ...returns] : returns
  const profile = data?.profile
  const writable = result?.canEdit && data?.canManage
  const frozen = command.busy || command.uncertain || command.stale || fileBusy
  async function submit(action: Action, body: object) {
    setFileError("")
    setNotice("")
    setLastAction(action)
    const response = await command.send<Reply<Agreement | Remittance | BankReturn | ReviewResult>>(
      root + action,
      tenant,
      { ...body, accountId },
      "",
      "POST",
      (reply) => {
        if (reply.tenantId !== tenant || !reply.data?.id) return false
        if (action === "cnab-profile") return "accountId" in reply.data && reply.data.accountId === accountId
        if (action === "cnab-review")
          return "returnId" in reply.data && reply.data.accountId === accountId && reply.data.ordinal > 0
        if (!("filename" in reply.data) || !reply.data.filename) return false
        if (action === "cnab-remittance") return "batchId" in reply.data && reply.data.batchId === batchId
        return "outcomes" in reply.data && Array.isArray(reply.data.outcomes)
      },
    )
    if (!response) return false
    if (action === "cnab-profile") {
      setEditing(false)
      setNotice("Convênio de cobrança salvo.")
    } else if (action === "cnab-remittance") {
      setNotice("Remessa gerada • " + (response.data as Remittance).filename)
    } else if (action === "cnab-review") {
      const reviewed = response.data as ReviewResult
      setLastReturn((current) => {
        if (current?.id !== reviewed.returnId) return current
        return {
          ...current,
          outcomes: current.outcomes.map((outcome) =>
            outcome.ordinal === reviewed.ordinal && !outcome.reviews?.some((attempt) => attempt.id === reviewed.id)
              ? { ...outcome, reviews: [...(outcome.reviews ?? []), reviewed] }
              : outcome,
          ),
        }
      })
      setNotice("Reavaliação registrada • " + (cnabStateNames[reviewed.state] ?? reviewed.state))
    } else {
      setLastReturn(response.data as BankReturn)
      setNotice("Retorno conferido • " + (response.data as BankReturn).filename)
    }
    if (action !== "cnab-review") setOffset(0)
    resource.reload()
    onChanged()
    return true
  }
  async function download(id: string) {
    setFileError("")
    setFileBusy(true)
    try {
      const response = await erpFetch(root + "cnab-remittance?" + new URLSearchParams({ accountId, batchId: id }))
      const body = await response.json()
      if (!response.ok) throw Error(body.title || "Falha ao consultar a remessa.")
      if (body.tenantId !== tenant || !body.data?.filename || typeof body.data.content !== "string")
        throw Error("Resposta de remessa inválida. Atualize a consulta e tente novamente.")
      const url = URL.createObjectURL(new Blob([body.data.content], { type: "application/octet-stream" }))
      const link = document.createElement("a")
      link.href = url
      link.download = body.data.filename
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Falha ao baixar a remessa.")
    } finally {
      setFileBusy(false)
    }
  }
  async function importFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file) return
    setFileBusy(true)
    setFileError("")
    try {
      await submit("cnab-return", { fileName: file.name, content: await readBankFile(file) })
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Falha ao ler o arquivo de retorno.")
    } finally {
      setFileBusy(false)
    }
  }
  return (
    <section className={styles.panel} aria-labelledby="cnab-collection-heading">
      <Button type="button" variant="outline" disabled={command.busy || command.uncertain || fileBusy} onClick={back}>
        Voltar ao borderô
      </Button>
      <div>
        <h3 id="cnab-collection-heading" className="text-lg font-semibold">
          Cobrança CNAB 240 • Santander
        </h3>
        <p>
          Borderô • {reference}
          {data && " • " + data.account.name}
        </p>
      </div>
      {resource.loading && <p role="status">Consultando arquivos da conta…</p>}
      {resource.error && (
        <p role="alert">
          <RequestError message={resource.error} status={resource.status} />
        </p>
      )}
      {command.error && (
        <p role="alert">
          <RequestError message={command.error} status={command.status} />
        </p>
      )}
      {fileError && <p role="alert">{fileError}</p>}
      {notice && <p role="status">{notice}</p>}
      {command.uncertain && (
        <Button type="button" disabled={command.busy} onClick={() => submit(lastAction, {})}>
          Conferir última operação CNAB
        </Button>
      )}
      {(resource.error || command.stale) && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            command.reset()
            resource.reload()
          }}
        >
          Atualizar consulta CNAB
        </Button>
      )}
      {data && (
        <>
          <section className="space-y-2 rounded-lg border p-3">
            <h4 className="font-semibold">Convênio da conta</h4>
            <p className="text-sm">
              {data.account.bank ?? "Banco sem cadastro"} • Agência {data.account.branch ?? "sem cadastro"} • Conta{" "}
              {data.account.accountNumber ?? "sem cadastro"}
            </p>
            {profile ? (
              <>
                <p>
                  {profile.name} • {profile.taxId} • Beneficiário {profile.beneficiaryCode}
                </p>
                <p className="text-sm">
                  Código de transmissão {profile.transmissionCode} • Próxima remessa {profile.nextSequence} • Próximo
                  nosso número {profile.nextOurNumber}
                </p>
                <p className="text-sm">
                  Após vencimento • Juros de {percent(profile.interestMonthlyBps)}% ao mês • Multa de{" "}
                  {percent(profile.fineBps)}%
                </p>
              </>
            ) : (
              <p>Esta conta ainda não tem convênio CNAB cadastrado.</p>
            )}
            {writable &&
              (editing ? (
                <ProfileForm
                  data={data}
                  disabled={frozen}
                  save={(body) => submit("cnab-profile", body)}
                  close={() => setEditing(false)}
                />
              ) : (
                <Button type="button" variant="outline" disabled={frozen} onClick={() => setEditing(true)}>
                  {profile ? "Editar convênio" : "Configurar convênio Santander"}
                </Button>
              ))}
          </section>
          <section className="space-y-2 rounded-lg border p-3">
            <h4 className="font-semibold">Remessa do borderô</h4>
            {remitted || data.remittances.some((r) => r.batchId === batchId) ? (
              <Button type="button" variant="outline" disabled={frozen} onClick={() => download(batchId)}>
                Baixar remessa original
              </Button>
            ) : (
              <>
                <p className="text-sm">
                  {canGenerate
                    ? "O ERP gera o arquivo para envio pelo canal bancário do convênio."
                    : "A geração exige um borderô ativo com todos os títulos disponíveis para emissão."}
                </p>
                {writable && (
                  <Button
                    type="button"
                    className={styles.primary}
                    disabled={frozen || !canGenerate || !profile || resource.loading}
                    onClick={() => submit("cnab-remittance", { batchId })}
                  >
                    Gerar remessa CNAB
                  </Button>
                )}
              </>
            )}
          </section>
          {writable && profile && (
            <form onSubmit={importFile} className="space-y-2 rounded-lg border p-3">
              <h4 className="font-semibold">Retorno da conta</h4>
              <p className="text-sm">
                A importação confere todos os títulos da conta presentes no arquivo. As liquidações confirmadas geram
                baixas. Consulte as rejeições e divergências no histórico.
              </p>
              <label className="grid max-w-lg gap-1 text-sm">
                Arquivo de retorno CNAB 240 • até 2 MB
                <Input
                  type="file"
                  disabled={frozen}
                  required
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null)
                    setFileError("")
                  }}
                />
              </label>
              <Button type="submit" disabled={!file || frozen}>
                Importar retorno CNAB
              </Button>
            </form>
          )}
          <section className="space-y-2" aria-label="Histórico CNAB da conta">
            <h4 className="font-semibold">Histórico CNAB da conta</h4>
            <h5 className="font-medium">Remessas geradas</h5>
            {!data.remittances.length && <p className="text-sm">Nenhuma remessa nesta página.</p>}
            {data.remittances.map((r) => (
              <div key={r.id} className={styles.receipt}>
                <p>
                  {r.filename} • Sequência {r.sequence} • {r.count} título(s) • {reaisFromCents(r.cents)}
                </p>
                <p className="text-sm">
                  {timestamp(r.createdAt)} • {r.createdBy} • Borderô {r.batchId === batchId ? reference : r.batchId}
                </p>
                <p className="break-all text-xs text-muted-foreground">SHA-256 do arquivo • {r.sha256}</p>
                {r.batchId !== batchId && (
                  <Button type="button" variant="outline" disabled={frozen} onClick={() => download(r.batchId)}>
                    Baixar {r.filename}
                  </Button>
                )}
              </div>
            ))}
            <h5 className="font-medium">Retornos importados</h5>
            {!receipts.length && <p className="text-sm">Nenhum retorno nesta página.</p>}
            {receipts.map((r) => (
              <ReturnReceipt
                key={r.id}
                file={r}
                expanded={r.id === lastReturn?.id}
                disabled={frozen || resource.loading}
                review={
                  writable
                    ? (returnId, ordinal, reason) => submit("cnab-review", { returnId, ordinal, reason })
                    : undefined
                }
              />
            ))}
            {(offset > 0 || data.moreRemittances || data.moreReturns) && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={frozen || offset === 0}
                  onClick={() => setOffset(offset - 20)}
                >
                  Página anterior de arquivos
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={frozen || (!data.moreRemittances && !data.moreReturns)}
                  onClick={() => setOffset(offset + 20)}
                >
                  Próxima página de arquivos
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  )
}
