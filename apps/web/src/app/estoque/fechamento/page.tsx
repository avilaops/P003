import {Suspense} from "react"
import {connection} from "next/server"
import {currentWorkspaceAccess,WorkspaceAccessNotice} from "@/features/access/workspace-access"
import {StockPeriods} from "@/features/inventory/stock-periods"
export const metadata = { title: "Custos e fechamento mensal" }
async function Content(){
  await connection()
  const access=await currentWorkspaceAccess()
  if(!access.session) return <WorkspaceAccessNotice state={access.state}/>
  return <StockPeriods key={access.session.tenantId} tenant={access.session.tenantId}/>
}
export default function Page(){return <Suspense fallback={<p role="status">Consultando competências…</p>}><Content/></Suspense>}
