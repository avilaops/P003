"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import { isDemonstrationRoute } from "@/lib/demonstration-routes"
import Link from "next/link"
import { unavailableFeatureFor } from "@/lib/unavailable-features"

export function DemonstrationPreview({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  if (!isDemonstrationRoute(pathname)) return <>{children}</>
  // Do not mount legacy preview components: their local state and example
  // records must never look like operations or data of the active company.
  const feature = unavailableFeatureFor(pathname) ?? { title: "Funcionalidade indisponível", purpose: "Esta funcionalidade ainda não oferece operações nesta empresa.", related: ["Visão geral", "/"] as const }
  const [label, href] = feature.related
  return <section className="mx-auto w-full min-w-0 max-w-3xl space-y-4 px-4 py-6 sm:py-10 lg:px-6" aria-labelledby="unavailable-feature-title">
    <p className="text-sm font-medium text-muted-foreground">Ainda indisponível nesta empresa</p>
    <h1 id="unavailable-feature-title" className="text-3xl font-semibold">{feature.title}</h1>
    <p className="text-muted-foreground">{feature.purpose} Esta função ainda não está disponível e não mostra dados de exemplo.</p>
    <nav aria-label="Operações disponíveis">
      <Link className="inline-flex min-h-11 items-center rounded-lg border bg-card px-4 py-2 font-medium text-primary hover:bg-accent" href={href}>Ir para {label}</Link>
    </nav>
  </section>
}
