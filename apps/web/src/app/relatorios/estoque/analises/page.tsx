import { Suspense } from "react"
import { connection } from "next/server"
import { currentWorkspaceAccess, WorkspaceAccessNotice } from "@/features/access/workspace-access"
import { StockAnalysis } from "@/features/reports/stock-analysis"

export const metadata={title:"Análises de estoque"}
async function Content(){
  await connection()
  const access=await currentWorkspaceAccess()
  if(!access.session)return <WorkspaceAccessNotice state={access.state}/>
  return <StockAnalysis key={access.session.tenantId} tenant={access.session.tenantId}/>
}
export default function Page(){return <Suspense fallback={<p role="status">Carregando análises de estoque…</p>}><Content/></Suspense>}
