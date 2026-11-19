import { Suspense } from "react"
import { connection } from "next/server"
import { PageHeader } from "@/components/page-header"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { StockMovementDetail } from "@/features/inventory/stock-movement-detail"

async function Access({ params }: PageProps<"/estoque/lancamentos/[id]">) {
  await connection()
  const access = await currentWorkspaceAccess()
  if (!access.session) return <div className="workspace-page-frame">
    <PageHeader eyebrow="Estoque / Lançamentos" title="Detalhe de lançamento" />
    <WorkspaceAccessNotice state={access.state} />
  </div>
  const tenant = access.session.tenantId
  return <StockMovementDetail key={tenant} tenant={tenant} id={(await params).id} />
}

export const metadata = { title: "Detalhes de lançamento de estoque" }

export default function MovementDetailPage(props: PageProps<"/estoque/lancamentos/[id]">) {
  return <Suspense fallback={<p role="status" className="p-6">Carregando lançamento…</p>}><Access {...props} /></Suspense>
}
