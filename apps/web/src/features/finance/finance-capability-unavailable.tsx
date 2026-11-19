import Link from "next/link"
import { PageHeader } from "@/components/page-header"

export function FinanceCapabilityUnavailable({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="workspace-page-frame">
      <PageHeader eyebrow="Financeiro" title={title} description={description} />
      <section className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <h2 className="text-sm font-semibold">Capacidade indisponível</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          A integração financeira desta rotina está pendente.
        </p>
        <Link className="mt-1 inline-flex min-h-9 items-center font-medium text-primary underline" href="/financeiro">
          Voltar para Financeiro
        </Link>
      </section>
    </div>
  )
}
