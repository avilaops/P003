import { useState } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { useCommand, useResource } from "@/hooks/use-operation"

type NfeEmail = {
  tenantId: string
  recipientEmail: string | null
  smtpConfigured: boolean
  status: "ready" | "sending" | "sent" | "unknown" | "failed"
}

export function NfeEmailPanel({ id, tenantId, onClose }: { id: string; tenantId: string; onClose: () => void }) {
  const url = `/api/erp/fiscal/nfe/${id}/email`
  const preview = useResource<NfeEmail>(url)
  const command = useCommand()
  const [result, setResult] = useState<NfeEmail | null>(null)
  const current = result ?? preview.value
  const matchesTenant = current?.tenantId === tenantId
  const recipient = matchesTenant ? current.recipientEmail : null
  const canSend = !result && recipient && current?.smtpConfigured && (current.status === "ready" || current.status === "failed")

  async function send() {
    if (!canSend || command.busy || preview.loading) return
    const response = await command.send<NfeEmail>(url, tenantId, { recipientEmail: recipient }, preview.etag, "POST",
      reply => reply.tenantId === tenantId && reply.recipientEmail === recipient)
    if (response) setResult(response)
  }

  function refresh() {
    setResult(null)
    command.reset()
    preview.reload()
  }

  return <section id="nfe-email" aria-label="Envio da NF-e por e-mail" className="space-y-3 rounded-xl border p-4">
    <h3 className="font-semibold">Enviar DANFE e XML</h3>
    {preview.loading ? <p role="status">Consultando o destinatário…</p> : preview.error ? <p role="alert">{preview.error}</p>
      : !matchesTenant ? <p role="alert">A empresa da sessão mudou. Reabra a nota.</p>
      : <>
        {recipient ? <p className="break-words">Destinatário • <strong>{recipient}</strong></p> : <p role="status">Cadastre um e-mail para o destinatário desta nota.</p>}
        {current.status === "sent" ? <p role="status">O serviço de e-mail aceitou a mensagem com os dois anexos.</p>
          : current.status === "sending" ? <p role="status">Envio em andamento.</p>
          : current.status === "unknown" ? <p role="alert">O serviço de e-mail ainda não confirmou o resultado.</p>
          : !current.smtpConfigured ? <p role="status">O serviço de e-mail está desativado. <Link className="text-primary underline" href="/preferencias/sistema/email">Configurar o e-mail da plataforma</Link></p>
          : current.status === "failed" ? <p role="alert">O serviço de e-mail recusou o envio do DANFE e do XML.</p>
          : <p className="text-sm text-muted-foreground">Anexos • DANFE em PDF e XML autorizado da NF-e.</p>}
      </>}
    {command.error && <p role="alert">{command.error}</p>}
    <div className="flex flex-wrap gap-2">
      {canSend && !preview.loading && !preview.error && !command.stale && <Button type="button" disabled={command.busy} onClick={() => void send()}>{command.busy ? "Enviando…" : command.uncertain ? "Conferir o mesmo envio" : "Confirmar envio"}</Button>}
      {(preview.error || command.error || result?.status === "failed" || current?.status === "sending" || current?.status === "unknown" || (current && !current.smtpConfigured)) && <Button type="button" variant="outline" disabled={command.busy || preview.loading} onClick={refresh}>Consultar envio</Button>}
      <Button type="button" variant="ghost" disabled={command.busy} onClick={onClose}>Fechar</Button>
    </div>
  </section>
}
