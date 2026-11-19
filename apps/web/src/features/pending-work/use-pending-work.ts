"use client"
import { useEffect } from "react"
import { useResource } from "@/hooks/use-operation"

export type PendingItem = {
  key: string
  group: "approvals" | "sales" | "finance" | "setup"
  title: string
  count: number
  amountCents: string | null
  href: string
  action: { label: string; href: string } | null
}
export type PendingWork = { tenantId: string; asOf: string; total: number; items: PendingItem[] }

const refreshEvery = 60_000

/** Painel de pendências do usuário; recarrega ao voltar para a aba e a cada minuto, para os itens resolvidos sumirem sem recarregar a página. */
export function usePendingWork() {
  const resource = useResource<PendingWork>("/api/erp/pending-work")
  const reload = resource.reload
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") reload() }
    const timer = window.setInterval(refresh, refreshEvery)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh) }
  }, [reload])
  return resource
}
