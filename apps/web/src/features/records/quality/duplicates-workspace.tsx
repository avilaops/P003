"use client"

import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { RequestError } from "@/components/feedback/session-recovery"
import { Button } from "@/components/ui/button"
import { useCommand, useResource } from "@/hooks/use-operation"

type Entity = "party" | "product"
type Side = { id: string; name: string; code: string | null; revision: number }
type Pair = { a: Side; b: Side; reasons: string[]; score: number }
type Duplicates = { tenantId: string; canMerge: boolean; truncated: boolean; data: Pair[] }
type Completeness = { total: number; incomplete: number; counts: Record<string, { label: string; total: number }>; data: { id: string; name: string; missing: string[] }[] }

const entityLabels: Record<Entity, { tab: string; noun: string; code: string }> = {
  party: { tab: "Clientes e fornecedores", noun: "cadastro", code: "Documento" },
  product: { tab: "Produtos", noun: "produto", code: "SKU" },
}
const reasonLabels: Record<string, string> = { same_email: "Mesmo e-mail", same_phone: "Mesmo telefone", similar_name: "Nome parecido" }

export function DuplicatesWorkspace() {
  const [entity, setEntity] = useState<Entity>("party")
  return <main className="mx-auto max-w-5xl space-y-4 p-4 text-sm">
    <PageHeader title="Duplicados e qualidade" breadcrumbs={[{ label: "Cadastros", href: "/cadastros" }, { label: "Duplicados e qualidade" }]} description="Pares com nome parecido, mesmo e-mail ou telefone, e cadastros com dados faltando. A mesclagem mantém os documentos dos dois registros." />
    <div role="tablist" aria-label="Tipo de cadastro" className="flex flex-wrap gap-2">
      {(Object.keys(entityLabels) as Entity[]).map(key => <Button key={key} role="tab" aria-selected={entity === key} variant={entity === key ? "default" : "outline"} size="sm" onClick={() => setEntity(key)}>{entityLabels[key].tab}</Button>)}
    </div>
    <Quality key={"q" + entity} entity={entity} />
    <Pairs key={"p" + entity} entity={entity} />
  </main>
}

function Quality({ entity }: { entity: Entity }) {
  const result = useResource<Completeness>(`/api/erp/data-quality/${entity}/completeness`)
  if (result.loading) return <p role="status">Consultando qualidade…</p>
  if (result.error) return <RequestError message={result.error} status={result.status} />
  const data = result.value
  if (!data) return null
  return <section aria-labelledby="quality-title" className="form-section space-y-2">
    <h2 id="quality-title" className="font-semibold">Completude • {data.incomplete} de {data.total} com dados faltando</h2>
    <ul className="flex flex-wrap gap-x-4 gap-y-1">{Object.entries(data.counts).map(([key, item]) => <li key={key}>{item.label}: <strong>{item.total}</strong></li>)}</ul>
    {data.data.length > 0 && <details><summary className="cursor-pointer">Ver os primeiros {data.data.length}</summary>
      <ul className="mt-2 space-y-1">{data.data.map(row => <li key={row.id}>{row.name} <span className="text-muted-foreground">• {row.missing.map(key => data.counts[key]?.label ?? key).join(", ")}</span></li>)}</ul></details>}
  </section>
}

function Pairs({ entity }: { entity: Entity }) {
  const result = useResource<Duplicates>(`/api/erp/data-quality/${entity}/duplicates`)
  const command = useCommand()
  const [message, setMessage] = useState("")
  const [choice, setChoice] = useState<{ pair: Pair; primary: "a" | "b" } | null>(null)
  if (result.loading) return <p role="status">Consultando duplicados…</p>
  if (result.error) return <RequestError message={result.error} status={result.status} />
  const data = result.value
  if (!data) return null
  async function merge() {
    if (!choice || !data) return
    const primary = choice.pair[choice.primary], secondary = choice.pair[choice.primary === "a" ? "b" : "a"]
    const done = await command.send("/api/erp/data-quality/merge", data.tenantId, { entity, primaryId: primary.id, secondaryId: secondary.id, primaryRevision: primary.revision, secondaryRevision: secondary.revision }, "", "POST", (reply: { tenantId: string; primaryId: string }) => reply.tenantId === data.tenantId && reply.primaryId === primary.id)
    if (done) { setMessage(`“${secondary.name}” foi mesclado em “${primary.name}”.`); setChoice(null); result.reload() }
  }
  const disabled = command.busy || command.uncertain || command.stale
  return <section aria-labelledby="pairs-title" className="form-section space-y-2">
    <h2 id="pairs-title" className="font-semibold">Prováveis duplicados • {data.data.length}</h2>
    {data.truncated && <p role="note" className="text-muted-foreground">A busca olhou apenas os primeiros 3.000 registros ativos.</p>}
    {message && <p role="status">{message}</p>}
    {data.data.length === 0 ? <p>Nenhum par suspeito encontrado.</p> : <ul className="divide-y">
      {data.data.map(pair => {
        const key = pair.a.id + pair.b.id, selected = choice?.pair === pair
        return <li key={key} className="space-y-1 py-2">
          <div className="grid gap-1 sm:grid-cols-2">{(["a", "b"] as const).map(side => <label key={side} className="flex items-start gap-2">
            <input type="radio" name={"primary-" + key} disabled={!data.canMerge || disabled} checked={selected && choice.primary === side} onChange={() => setChoice({ pair, primary: side })} />
            <span><strong>{pair[side].name}</strong><br /><span className="text-muted-foreground">{entityLabels[entity].code}: {pair[side].code ?? "—"}</span></span></label>)}</div>
          <p className="text-muted-foreground">{pair.reasons.map(reason => reasonLabels[reason] ?? reason).join(" • ")} • similaridade {Math.round(pair.score * 100)}%</p>
          {data.canMerge && selected && <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmar mesclagem">
            <span>O outro {entityLabels[entity].noun} será arquivado e seus documentos passam para o principal.</span>
            <Button size="sm" disabled={disabled} onClick={() => void merge()}>Confirmar mesclagem</Button>
            <Button size="sm" variant="outline" disabled={command.busy} onClick={() => setChoice(null)}>Cancelar</Button></div>}
        </li>
      })}
    </ul>}
    {!data.canMerge && data.data.length > 0 && <p className="text-muted-foreground">Você pode consultar, mas não mesclar.</p>}
    {command.error && <p role="alert">{command.error}</p>}{command.stale && <Button size="sm" onClick={result.reload}>Atualizar lista</Button>}
  </section>
}
