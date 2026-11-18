import { Suspense } from "react"
import { connection } from "next/server"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { StockLocations } from "@/features/inventory/stock-locations"

export const metadata = {title: "Transferências entre depósitos"}
async function Access() {
  await connection()
  const access = await currentWorkspaceAccess()
  if (!access.session) return <WorkspaceAccessNotice state={access.state} />
  return <StockLocations key={access.session.tenantId} tenant={access.session.tenantId} />
}
export default function Page() {
  return <Suspense fallback={<p role="status">Carregando depósitos…</p>}><Access /></Suspense>
}
