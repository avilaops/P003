import { ChevronDown } from "lucide-react"
import { GuardedLink } from "@/components/shell/navigation-guard"
import { Button, buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export function NewOrderActions() {
  return <div className="inline-flex items-stretch">
    <GuardedLink className={buttonVariants({ className: "h-10 rounded-r-none px-3" })} href="/vendas/pedidos/novo">Novo pedido</GuardedLink>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button className="h-10 rounded-l-none border-l border-primary-foreground/30 px-2" aria-label="Mais opções de novo pedido" />}>
        <ChevronDown aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem render={<GuardedLink href="/vendas/pedidos/novo?modo=catalogo" />}>Pedido pelo catálogo</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
}
