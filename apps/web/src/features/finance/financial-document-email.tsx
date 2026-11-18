"use client"

import { useEffect, useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RequestError } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"
import { dateLabel, reais } from "./finance-insights-model"

type Delivery = { id: string; status: "sent" | "failed" | "uncertain"; recipient: string; createdAt: string }
type ReportSummary = { companyName: string; asOf: string; totals: { receivable: string; payable: string; overdueReceivable: string; overduePayable: string } }
type EmailSnapshot = { tenantId: string; canSend: boolean; emailReady: boolean; recipient: string | null; documentTitle: string; scope: string; recordCount: number; summary?: ReportSummary; snapshotHash: string; deliveries: Delivery[] }
type Receipt = { tenantId: string; revision: number; delivery: Delivery }
type Props = { tenantId: string; receivableId?: string; payableId?: string; contractId?: string; reportQuery?: string; disabled?: boolean; onLockChange?: (locked: boolean) => void }
const labels = { sent: "Aceito pelo servidor de e-mail", failed: "Recusado pelo servidor de e-mail", uncertain: "Confirmação pendente • não criar outro envio" }

export function FinancialDocumentEmail(props: Props) {
  const [activated, setActivated] = useState(false)
  // The command owner remains mounted when the dialog closes.
  return activated ? <FinancialEmailComposer {...props} /> : <Button variant="outline" disabled={props.disabled} onClick={() => setActivated(true)}>{props.contractId ? "Enviar cópia do contrato por e-mail" : "Enviar por e-mail"}</Button>
}

function FinancialEmailComposer({ tenantId, receivableId, payableId, contractId, reportQuery, disabled = false, onLockChange }: Props) {
  const [open, setOpen] = useState(true)
  const endpoint = contractId ? `/api/erp/commercial-contracts/${contractId}/email` : payableId ? `/api/erp/financial-payables/${payableId}/email` : receivableId ? `/api/erp/receivables/${receivableId}/email` : "/api/erp/financial-report/email"
  const registeredRecipient = Boolean(contractId || payableId)
  const resource = useResource<EmailSnapshot>(reportQuery ? endpoint + "?" + reportQuery : endpoint)
  const me = useResource<{ tenant: { id: string } }>("/api/erp/me")
  const command = useCommand()
  const messageId = useId()
  const [recipientOverride, setRecipientOverride] = useState<string | null>(null)
  const [subjectOverride, setSubjectOverride] = useState<string | null>(null)
  const [message, setMessage] = useState(contractId ? "Olá,\n\nSegue a cópia do contrato para sua conferência." : "Olá,\n\nSegue o documento financeiro em anexo para conferência.\n\nFicamos à disposição.")
  const [receipt, setReceipt] = useState<Delivery | null>(null)
  const value = resource.value?.tenantId === tenantId && me.value?.tenant?.id === tenantId ? resource.value : null
  const pendingDelivery = receipt?.status === "uncertain" || !!value?.deliveries.some(delivery => delivery.status === "uncertain")
  const locked = command.busy || command.uncertain || !!pendingDelivery
  const frozen = locked || command.stale || receipt?.status === "sent"
  const recipient = (registeredRecipient ? value?.recipient : recipientOverride ?? (receivableId ? value?.recipient : "")) ?? ""
  const subject = subjectOverride ?? value?.documentTitle ?? "Documento financeiro"
  const validSnapshot = !!value && /^[a-f0-9]{64}$/.test(value.snapshotHash) && /^"\d+"$/.test(resource.etag)
  const ready = !disabled && !resource.loading && !me.loading && !resource.error && !me.error && validSnapshot && value?.canSend && value.emailReady
  const lockParent = reportQuery === undefined ? locked : command.busy || command.uncertain
  useEffect(() => { onLockChange?.(lockParent) }, [lockParent, onLockChange])
  useEffect(() => () => onLockChange?.(false), [onLockChange])
  function refresh() { if (command.busy || command.uncertain) return; command.reset(); setReceipt(null); resource.reload(); me.reload() }
  return <>
    <Button variant="outline" disabled={disabled && !locked} onClick={() => { if (!frozen) refresh(); setOpen(true) }}>{contractId ? "Enviar cópia do contrato por e-mail" : "Enviar por e-mail"}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{contractId ? "Enviar cópia do contrato por e-mail" : "Enviar documento financeiro por e-mail"}</DialogTitle><DialogDescription>{contractId ? "Confira os destinatários da cópia e a mensagem. O anexo é o PDF preservado deste contrato." : "Confira o destinatário, o escopo e a mensagem. O PDF é gerado pelo servidor com os dados registrados."}</DialogDescription></DialogHeader>
      {(resource.loading || me.loading) && !command.uncertain ? <p role="status">Consultando documento e configuração de envio…</p> : <form className="space-y-4" onSubmit={async event => {
        event.preventDefault()
        if (command.busy || command.stale || (!command.uncertain && (!ready || frozen))) return
        const filters = reportQuery ? Object.fromEntries(new URLSearchParams(reportQuery)) : undefined
        const result = await command.send<Receipt>(endpoint, tenantId, { recipient, subject, message, snapshotHash: value?.snapshotHash, filters }, resource.etag, "POST", reply => {
          if (reply.tenantId !== tenantId || !reply.delivery || !["sent", "failed", "uncertain"].includes(reply.delivery.status)) return false
          setReceipt(reply.delivery)
          return reply.delivery.status !== "uncertain"
        })
        if (result) resource.reload()
      }}>
        {(resource.error || me.error || !value || !validSnapshot) && <div role="alert"><RequestError message={resource.error || me.error || "Não foi possível conferir o documento e a revisão da empresa ativa."} status={resource.error ? resource.status : me.status} /></div>}
        {value && <div className="rounded-lg border bg-muted/30 p-3 text-sm"><p className="font-medium">{value.documentTitle}</p><p>{value.scope}</p>{contractId ? <p>{value.recordCount} arquivo(s) PDF</p> : <><p>{value.recordCount} registro(s) • PDF A4 do servidor</p><p>O envio não altera saldos ou recebimentos e não comprova conciliação bancária.</p></>}</div>}
        {value?.summary && <div className="space-y-1 text-sm"><p className="font-medium">{value.summary.companyName} • posição em {dateLabel(value.summary.asOf)}</p>
          <p>A receber • {reais(value.summary.totals.receivable)} • A pagar • {reais(value.summary.totals.payable)}</p>
          <p>Recebíveis vencidos • {reais(value.summary.totals.overdueReceivable)} • Pagamentos vencidos • {reais(value.summary.totals.overduePayable)}</p></div>}
        {value && !value.emailReady && <p role="status">O envio de e-mail ainda não está configurado no servidor.</p>}
        {value && !value.canSend && <p role="status">{registeredRecipient && !recipient ? "Confira os e-mails no cadastro dos destinatários." : contractId ? "Confira a revisão do contrato, a disponibilidade do PDF e a permissão de envio." : "Envio indisponível • confira sua permissão de gestão financeira e a situação do título."}</p>}
        <fieldset disabled={!ready || frozen} className="space-y-3">
          {registeredRecipient ? <p className="break-all">Destinatário • <strong>{recipient || "E-mail não cadastrado"}</strong></p> : <label className="block space-y-2">Destinatário<Input type="email" autoComplete="email" required maxLength={254} value={recipient} onChange={event => setRecipientOverride(event.target.value)} /></label>}
          <label className="block space-y-2">Assunto<Input required maxLength={200} value={subject} onChange={event => setSubjectOverride(event.target.value)} /></label>
          <div className="space-y-2"><label className="block" htmlFor={messageId}>Mensagem</label><textarea id={messageId} required maxLength={10000} rows={5} className="w-full rounded-lg border border-input bg-background p-3" value={message} onChange={event => setMessage(event.target.value)} /></div>
        </fieldset>
        {command.error && <p role="alert"><RequestError message={command.error} status={command.status} /></p>}
        {command.stale && <p role="status">Os dados mudaram. Recarregue o documento e confira novamente antes de enviar.</p>}
        {receipt && <p role="status">{labels[receipt.status]} • {receipt.recipient}{receipt.status === "sent" ? ". A entrega na caixa do destinatário depende do provedor." : "."}</p>}
        {pendingDelivery && <p role="status">Há um envio sem confirmação definitiva. Nenhum novo envio será criado neste contexto.</p>}
        {command.uncertain && <p role="status">Resultado ainda não confirmado • a consulta repete a mesma chave e a mesma mensagem.</p>}
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={command.busy || command.stale || (!command.uncertain && (!ready || frozen))}>{command.busy ? "Confirmando envio…" : command.uncertain ? "Consultar resultado do envio" : "Enviar e-mail com anexo"}</Button><Button type="button" variant="outline" disabled={command.busy || command.uncertain} onClick={refresh}>{command.stale ? "Recarregar documento para conferência" : "Atualizar documento e histórico"}</Button></div>
        {!!value?.deliveries.length && <details><summary className="cursor-pointer font-medium">Histórico de envios</summary><ul className="mt-3 space-y-3 text-sm">{value.deliveries.map(delivery => <li className="break-words rounded-lg border p-3" key={delivery.id}>{labels[delivery.status]}<br />{delivery.recipient} • {new Date(delivery.createdAt).toLocaleString("pt-BR")}</li>)}</ul></details>}
      </form>}
    </DialogContent></Dialog>
  </>
}
