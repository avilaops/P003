import { Suspense } from "react"
import { connection } from "next/server"
import { PageHeader } from "@/components/page-header"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { StockWorkspace } from "./stock-workspace"

export function StockPage({ path }: { path: string }) {
  return <Suspense fallback={<p role="status">Carregando estoque…</p>}><StockAccess path={path} /></Suspense>
}

async function StockAccess({ path }: { path: string }) {
  await connection()
  const access = await currentWorkspaceAccess()
  if (!access.session) return <div className="workspace-page-frame">
    <PageHeader eyebrow="Estoque" title="Saldos e movimentos" description="Estoque da empresa ativa." />
    <WorkspaceAccessNotice state={access.state} />
  </div>
  return <StockWorkspace key={access.session.tenantId} tenant={access.session.tenantId} path={path} />
}
