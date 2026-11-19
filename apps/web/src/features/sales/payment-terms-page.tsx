"use client"

import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { RequestError } from "@/components/feedback/session-recovery"
import { useResource } from "@/hooks/use-operation"
import { PaymentTermsEditor } from "./payment-terms-editor"
import type { PolicyCatalog } from "./policy-settings"

// Cadastros → Condições de pagamento: a mesma tabela e a mesma rota usadas pelo pedido e pela proposta.
export function PaymentTermsPage() {
  const result = useResource<PolicyCatalog>("/api/erp/commercial/policies/catalog")
  const [message, setMessage] = useState("")
  const data = result.value
  return <main className="mx-auto max-w-4xl space-y-4 p-4 text-sm">
    <PageHeader title="Condições de pagamento" breadcrumbs={[{ label: "Cadastros", href: "/cadastros" }, { label: "Condições de pagamento" }]} description="Entrada e vencimentos em dias, com a forma de pagamento. O pedido e a proposta guardam uma cópia ao aplicar a condição." />
    {result.loading ? <p role="status">Consultando condições…</p> : result.error ? <RequestError message={result.error} status={result.status} /> : !data ? null : <>
      <section aria-labelledby="terms-list" className="form-section">
        <h2 id="terms-list" className="mb-2 font-semibold">Cadastradas • {data.terms.length}</h2>
        {data.terms.length === 0 ? <p>Nenhuma condição cadastrada.</p> : <table className="w-full text-left"><thead><tr><th>Nome</th><th>Entrada</th><th>Vencimentos (dias)</th><th>Forma</th><th>Situação</th></tr></thead>
          <tbody>{data.terms.map(term => <tr key={term.id} className="border-t"><td>{term.name}</td><td>{term.entryBps / 100}%</td><td>{term.days.join(", ") || "À vista"}</td><td>{data.methods.find(method => method.id === term.methodId)?.name ?? "—"}</td><td>{term.active ? "Ativa" : "Inativa"}</td></tr>)}</tbody></table>}
      </section>
      {data.manage ? <PaymentTermsEditor data={data} reload={result.reload} onSaved={() => { setMessage("Condição salva."); result.reload() }} /> : <p>A gestão da empresa mantém as condições de pagamento.</p>}
      {message && <p role="status">{message}</p>}
    </>}
  </main>
}
