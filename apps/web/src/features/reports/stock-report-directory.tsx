"use client"

import { ArrowUpRight } from "lucide-react"
import { GuardedLink } from "@/components/shell/navigation-guard"
import { ErrorState } from "@/components/workspace/resource-state"
import { useResource } from "@/hooks/use-operation"

type Catalog = { tenantId: string; sources: Record<string, { label: string }> }

const groups = [
  { name: "Movimentação e depósitos", datasets: ["stock_movement_activity", "stock_kardex", "stock_position"] },
  { name: "Conferência e produção", datasets: ["stock_count_progress", "stock_divergences", "stock_accuracy", "stock_production_progress"] },
  { name: "Planejamento de estoque", datasets: ["stock_turnover", "stock_idle", "stock_abc"] },
]

export function StockReportDirectory({ tenant }: { tenant: string }) {
  const catalog = useResource<Catalog>("/api/erp/stock/reports?catalog=true")
  if (catalog.loading) return <p role="status">Carregando catálogo de relatórios…</p>
  if (catalog.error) return <ErrorState title="Não foi possível carregar o catálogo" message={catalog.error} status={catalog.status} onRetry={catalog.reload} />
  if (catalog.value?.tenantId !== tenant) return null
  const sources = catalog.value.sources
  return <nav aria-label="Catálogo de relatórios de estoque" className="grid gap-3 md:grid-cols-3">
    {groups.map(group => {
      const allowed = group.datasets.filter(id => sources[id])
      if (!allowed.length) return null
      return <section key={group.name} className="min-w-0 rounded-xl border border-border bg-card px-4 py-3">
        <h2 className="mb-1 font-semibold">{group.name}</h2>
        <ul className="divide-y divide-border">{allowed.map(id => <li key={id}>
          <GuardedLink href={"/relatorios/estoque/analises?dataset=" + id}
            className="flex min-h-11 items-center justify-between gap-2 py-2 text-sm font-medium text-primary hover:underline">
            {sources[id].label}<ArrowUpRight aria-hidden="true" className="size-4 shrink-0"/>
          </GuardedLink>
        </li>)}</ul>
      </section>
    })}
  </nav>
}
