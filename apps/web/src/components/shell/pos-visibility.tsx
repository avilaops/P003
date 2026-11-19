"use client"

import { createContext, useContext, useEffect, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { useResource } from "@/hooks/use-operation"
import { GuardedLink } from "./navigation-guard"

type PosPreference = { data?: { enabled?: boolean } }
const PosVisibility = createContext<boolean|null>(null)
export function isPosDestination(href: string) {
  return /^\/vendas\/pdv(?:[/?#]|$)/.test(href)
}
export function usePosVisibility() { return useContext(PosVisibility) !== false }

export function PosVisibilityProvider({children}:{children:ReactNode}) {
  const preference=useResource<PosPreference>("/api/erp/pos/settings")
  const {reload}=preference
  useEffect(()=>{
    window.addEventListener("erp:pos-settings",reload)
    return ()=>window.removeEventListener("erp:pos-settings",reload)
  },[reload])
  const enabled=preference.loading && !preference.value ? null : preference.value?.data?.enabled !== false
  return <PosVisibility.Provider value={enabled}>{children}</PosVisibility.Provider>
}

export function PosRoute({children}:{children:ReactNode}) {
  const enabled=useContext(PosVisibility)
  const pathname=usePathname()
  if (enabled===null && isPosDestination(pathname)) return <p className="p-6" role="status">Consultando a preferência do caixa…</p>
  if (enabled===false && isPosDestination(pathname)) return <section className="space-y-3 p-6">
    <h1 className="text-xl font-semibold">PDV desativado para esta empresa</h1>
    <GuardedLink className="underline" href="/vendas">Voltar para Vendas</GuardedLink>
  </section>
  return children
}
