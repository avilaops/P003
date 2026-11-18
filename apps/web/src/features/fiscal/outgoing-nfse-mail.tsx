"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { PageTitle } from "@/components/workspace/page-title"
import { useResource } from "@/hooks/use-operation"
import { NfeEmailPanel } from "./nfe-email-panel"

type Issuances = {
  tenantId: string; canSend: boolean; hasMore: boolean;
  data: { id: string; number: string | null; accessKey: string; environment: string }[]
}

export function OutgoingNfseMail() {
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState("")
  const access = useResource<{ tenant: { id: string } }>("/api/erp/me")
  const list = useResource<Issuances>("/api/erp/fiscal/outgoing-nfses?offset=" + offset)
  const page = access.value?.tenant?.id === list.value?.tenantId ? list.value : null
  function go(next: number) { setSelected(""); setOffset(next) }
  return <main className="space-y-4">
    <PageTitle>NFS-e emitidas</PageTitle>
    <Link href="/fiscal/nfses" className="text-sm text-primary underline">NFS-e recebidas</Link>
    {access.loading || list.loading ? <p role="status">Consultando notas emitidas…</p>
      : access.error || list.error || !page ? <p role="alert">{access.error || list.error || "A empresa da sessão mudou. Reabra as notas."}</p>
      : <>
        {!page.data.length && <p>Nenhuma NFS-e autorizada com XML nesta página.</p>}
        {page.data.map(note => <article key={note.id} className="space-y-3 rounded-xl border p-4">
          <h2 className="font-semibold">NFS-e {note.number}</h2>
          <p>{note.environment === "homologation" ? "Homologação • sem valor fiscal" : "Produção"}</p>
          <p className="break-all text-sm">Chave de acesso • {note.accessKey}</p>
          {page.canSend && <Button variant="outline" aria-expanded={selected === note.id} aria-controls={"fiscal-email-" + note.id} onClick={() => setSelected(note.id)}>Enviar por e-mail</Button>}
          {page.canSend && selected === note.id && <NfeEmailPanel key={page.tenantId + note.id} id={note.id} tenantId={page.tenantId} kind="outgoing-nfses" label="NFS-e" onClose={() => setSelected("")} />}
        </article>)}
        {(offset > 0 || page.hasMore) && <nav aria-label="Páginas de NFS-e emitidas" className="flex gap-2">
          <Button disabled={!offset} variant="outline" onClick={() => go(Math.max(0, offset - 25))}>Anteriores</Button>
          <Button disabled={!page.hasMore} variant="outline" onClick={() => go(offset + 25)}>Próximas</Button>
        </nav>}
      </>}
  </main>
}
