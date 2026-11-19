import { Suspense } from "react"
import { connection } from "next/server"
import { PageHeader } from "@/components/page-header"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { Payables } from "./payables"
import { PurchaseDetail, PurchaseReceipt } from "./purchase-detail"
import { PurchaseEditor } from "./purchase-editor"
import { PurchaseList } from "./purchase-list"
import { PurchaseOverview } from "./purchase-overview"

type View = "overview" | "orders" | "create" | "detail" | "edit" | "receipts" | "receipt" | "payables"
type Props = { view: View; params?: Promise<{ id: string }> }
export function PurchaseAccess(props: Props) {
  return <Suspense fallback={<p role="status">Carregando acesso às compras…</p>}><AuthorizedPurchase {...props} /></Suspense>
}
async function AuthorizedPurchase({ view, params }: Props) {
  await connection()
  const access = await currentWorkspaceAccess()
  const id = params ? (await params).id : undefined
  return <div className="workspace-page-frame">
    {!access.session ? <><PageHeader eyebrow={view === "payables" ? "Financeiro" : "Compras"} title={view === "payables" ? "Contas a pagar" : "Compras"} description="Operações da empresa ativa." /><WorkspaceAccessNotice state={access.state} /></> : view === "overview" ? <>
      <PageHeader eyebrow="Compras" title="Visão geral" description="Pedidos, recebimentos e contas a pagar da empresa ativa." />
      <PurchaseOverview />
    </> : view === "payables" ? <Payables id={id} /> : view === "create" || view === "edit" ? <PurchaseEditor id={id} /> : view === "detail" && id ? <PurchaseDetail key={id} id={id} /> : view === "receipt" && id ? <PurchaseReceipt key={id} id={id} /> : <PurchaseList receiving={view === "receipts"} />}
  </div>
}
