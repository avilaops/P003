import { Button } from "@/components/ui/button"
import { useResource } from "@/hooks/use-operation"

type Review = {
  tenantId: string; contractId: string; emailReady: boolean; closingHash: string; recipients: string[]
  completePackage: boolean; packageStatus: "sending" | "unknown" | "failed" | "sent" | null
  checks: { label: string; detail: string; ready: boolean }[]
}

export function PackageReview({ id, tenantId, etag, blocked, send, close }: {
  id: string; tenantId: string; etag: string; blocked: boolean
  send: (hash?: string) => void; close: () => void
}) {
  const review = useResource<Review>(`/api/erp/commercial-contracts/${id}/send-package`)
  const value = review.value
  const matches = value?.tenantId === tenantId && value.contractId === id && review.etag === etag
  const received = value?.packageStatus === "sent"
  const pending = value?.packageStatus === "sending" || value?.packageStatus === "unknown"
  const canSend = matches && value.emailReady && !pending && !(received && value.completePackage)
  const complete = !!value?.checks.length && value.checks.every(check => check.ready)
  return <section aria-label="Conferência do fechamento" className="space-y-3">
    {review.loading ? <p role="status">Conferindo documentos do pedido…</p> : review.error || !matches
      ? <p role="alert">{review.error || "O contrato mudou. Reabra a conferência."}</p>
      : <>
        <h3 className="font-semibold">Documentos do fechamento</h3>
        <ul className="space-y-2 text-sm">{value.checks.map(check => <li key={check.label}><strong>{check.label}</strong> • {check.ready ? "Disponível" : "Pendente"}<br />{check.detail}</li>)}</ul>
        <p>Destinatários • {value.recipients.join(", ")}</p>
        {pending ? <p role="status">O serviço ainda não confirmou o último envio.</p>
          : received && value.completePackage ? <p role="status">O serviço de e-mail já aceitou o pacote completo.</p>
          : !value.emailReady ? <p role="status">O serviço de envio de documentos está indisponível.</p>
          : received && <p role="status">O envio anterior continha apenas parte dos documentos.</p>}
        <Button disabled={blocked || !canSend || !complete} onClick={() => send(value.closingHash)}>Enviar fechamento completo</Button>
        {!complete && !received && !pending && value.checks.filter(check => ["Contrato","Pedido","NF-e"].includes(check.label)).every(check => check.ready) &&
          <Button variant="outline" disabled={blocked || !canSend} onClick={() => send()}>Enviar apenas os documentos disponíveis</Button>}
      </>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={blocked || review.loading} onClick={review.reload}>Atualizar conferência</Button><Button variant="outline" disabled={blocked} onClick={close}>Voltar</Button></div>
  </section>
}
