import { CatalogPending } from "@/features/catalog/catalog-pending"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"

export const metadata = { title: "Pendências de cadastro" }

export default async function Page() {
  const access = await currentWorkspaceAccess()
  return access.session ? <CatalogPending /> : <WorkspaceAccessNotice state={access.state} />
}
