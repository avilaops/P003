"use client"

import { RequestError } from "@/components/feedback/session-recovery"
import { DataTable } from "@/components/workspace/data-table"
import { useResource } from "@/hooks/use-operation"

type Change = { before: unknown; after: unknown }
type Entry = { id: string; occurredAt: string; actor: string | null; action: string; revision: number | null; changes: Record<string, Change> }
type History = { tenantId: string; data: Entry[]; nextCursor: string | null }

const actions: Record<string, string> = { created: "Criado", updated: "Alterado", merged: "Mesclado", archived_by_merge: "Arquivado por mesclagem" }
const fields: Record<string, string> = {
  legalName: "Razão social / nome", tradeName: "Nome fantasia", taxId: "Documento", email: "E-mail", phone: "Telefone", isCustomer: "Cliente", isSupplier: "Fornecedor", status: "Situação",
  addresses: "Endereços", contacts: "Contatos", fiscal: "Dados fiscais", personType: "Tipo de pessoa", name: "Nome", code: "Código", sku: "SKU", unit: "Unidade", ncm: "NCM", cest: "CEST",
  priceCents: "Preço (centavos)", categoryId: "Categoria", notes: "Observações", photoDataUrl: "Foto", groupId: "Grupo", parentId: "Categoria superior", sortOrder: "Ordem", location: "Localização",
}
const label = (key: string) => fields[key] ?? key
const show = (value: unknown) => value === null || value === undefined || value === "" ? "—" : typeof value === "object" ? JSON.stringify(value) : typeof value === "boolean" ? (value ? "Sim" : "Não") : String(value)
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
const actionLabel = (action: string) => actions[action.split(".").slice(1).join(".")] ?? action

/** Aba/seção Histórico reutilizável por qualquer cadastro: `entity` é o tipo aceito por GET /api/v1/history/:entity/:id. */
export function RecordHistory({ entity, id }: { entity: string; id: string }) {
  const result = useResource<History>(`/api/erp/history/${entity}/${id}`)
  return <section aria-labelledby={`history-${id}`} className="form-section space-y-2 text-sm">
    <h2 id={`history-${id}`} className="font-semibold">Histórico de alterações</h2>
    {result.loading ? <p role="status">Consultando histórico…</p> : result.error ? <RequestError message={result.error} status={result.status} /> : !result.value?.data.length ? <p>Nenhuma alteração registrada.</p> : <>
      <DataTable><caption className="sr-only">Alterações do cadastro, da mais recente para a mais antiga</caption>
        <thead><tr><th>Quando</th><th>Quem</th><th>O quê</th></tr></thead>
        <tbody>{result.value.data.map(entry => <tr key={entry.id} className="border-t align-top">
          <td className="whitespace-nowrap">{when(entry.occurredAt)}</td><td>{entry.actor ?? "Sistema"}</td>
          <td><strong>{actionLabel(entry.action)}</strong>{entry.revision ? <span className="text-muted-foreground"> • revisão {entry.revision}</span> : null}
            {Object.entries(entry.changes).length > 0 && <ul className="mt-1 space-y-0.5">{Object.entries(entry.changes).map(([key, change]) => <li key={key}>{label(key)}: <del className="text-muted-foreground">{show(change.before)}</del> → <ins className="no-underline">{show(change.after)}</ins></li>)}</ul>}
          </td></tr>)}</tbody></DataTable>
      {result.value.nextCursor && <p className="text-muted-foreground">Mostrando as 25 alterações mais recentes.</p>}
    </>}
  </section>
}
