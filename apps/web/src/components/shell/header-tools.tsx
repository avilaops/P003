"use client"

import { Bell, Building2, CircleUserRound } from "lucide-react"
import { GuardedLink as Link } from "./navigation-guard"
import { LogoutButton } from "./logout-button"
import { useResource } from "@/hooks/use-operation"
import { usePendingWork } from "@/features/pending-work/use-pending-work"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

import { useTheme } from "./theme-provider"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuGroup, DropdownMenuLabel } from "@/components/ui/dropdown-menu"

type Access = { tenant?: { id?: string; legalName?: string; tradeName?: string | null } }

export function HeaderTools() {
  const [theme, setTheme] = useTheme()
  const access = useResource<Access>("/api/erp/me")
  const pending = usePendingWork().value?.total ?? 0
  const legalName = access.value?.tenant?.legalName?.trim() || "Empresa ativa"
  const company = access.value?.tenant?.tradeName?.trim() || legalName
  const companyDescription = company === legalName ? legalName : `${company} • ${legalName}`
  return <div className="erp-global-actions">
    <Link className="icon-action erp-header-notifications relative" href="/notificacoes" aria-label={pending ? `Notificações • ${pending} pendências` : "Notificações"} title="Notificações"><Bell />{pending > 0 && <span data-testid="bell-count" className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[0.7rem] leading-4 text-primary-foreground">{pending > 99 ? "99+" : pending}</span>}</Link>
    <TooltipProvider><Tooltip><TooltipTrigger render={<Link className="erp-company-link" href="/empresas" aria-label={`Suas empresas • ${companyDescription} • Trocar empresa`} title={companyDescription + " • Trocar empresa"} />}><Building2 aria-hidden="true" /><span><small>Empresa ativa</small><strong>{company}</strong></span></TooltipTrigger><TooltipContent className="max-w-80 break-words">{companyDescription} • Trocar empresa</TooltipContent></Tooltip></TooltipProvider>
    <DropdownMenu>
      <DropdownMenuTrigger className="icon-action" aria-label="Conta • Aparência" title="Conta • Aparência"><CircleUserRound aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" aria-label="Conta • Aparência">
        <DropdownMenuGroup><DropdownMenuLabel>Aparência</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={value => { if (value === "light" || value === "dark" || value === "system" || value === "avila") setTheme(value) }}>
            <DropdownMenuRadioItem className="min-h-11" value="light">Claro</DropdownMenuRadioItem>
            <DropdownMenuRadioItem className="min-h-11" value="dark">Escuro</DropdownMenuRadioItem>
            <DropdownMenuRadioItem className="min-h-11" value="system">Sistema</DropdownMenuRadioItem>
            <DropdownMenuRadioItem className="min-h-11" value="avila">Ávila</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <LogoutButton label="" className="icon-action" />
  </div>
}
