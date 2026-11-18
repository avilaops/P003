import { Suspense } from "react"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { PageHeader } from "@/components/page-header"
import { InventoryCounts } from "./inventory-counts"
import { InventoryCountDetail } from "./inventory-count-detail"

type Props = { params?: Promise<{ id: string }>; create?: boolean }
async function Access({ params, create }: Props) {
  const access = await currentWorkspaceAccess()
  if (!access.session)
    return (
      <div className="workspace-page-frame">
        <PageHeader title="Conferência de estoque" />
        <WorkspaceAccessNotice state={access.state} />
      </div>
    )
  const tenant = access.session.tenantId
  return params ? (
    <InventoryCountDetail tenant={tenant} key={tenant} id={(await params).id} />
  ) : (
    <InventoryCounts tenant={tenant} key={tenant} create={Boolean(create)} />
  )
}
export function CountPage(props: Props) {
  return (
    <Suspense fallback={<p role="status">Carregando inventário…</p>}>
      <Access {...props} />
    </Suspense>
  )
}
