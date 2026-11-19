import { connection } from "next/server"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { PageHeader } from "@/components/page-header"
import { Orders } from "./orders"
import { CommercialSimulator } from "./commercial-simulator"

type CommercialPrefill = Pick<React.ComponentProps<typeof CommercialSimulator>, "initialLine" | "initialItems" | "initialDestination" | "initialTaxpayer" | "initialOpportunity" | "transferId">
export async function OrdersAccess({ prefill, id, create = false, edit = false, commercialCreate = false }: { prefill?: CommercialPrefill; id?: string; create?: boolean; edit?: boolean; commercialCreate?: boolean }) {
  await connection()
  const access = await currentWorkspaceAccess()
  return <div className={commercialCreate ? "workspace-page-frame order-page-frame" : "workspace-page-frame"}>
    {!access.session ? <><PageHeader eyebrow="Vendas" title="Pedidos de venda" description="Operações da empresa ativa." /><WorkspaceAccessNotice state={access.state} /></> : commercialCreate ? <CommercialSimulator initialLine="imported" initialProduct="" {...prefill} orderMode /> : <Orders id={id} create={create} edit={edit} />}
  </div>
}
