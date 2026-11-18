import {Suspense} from "react"
import {currentWorkspaceAccess,WorkspaceAccessNotice} from "@/features/access/workspace-access"
import {SerialWorkspace} from "@/features/inventory/serial-workspace"

export const metadata = { title: "Rastreamento por número de série" }
async function Access(){
  const access=await currentWorkspaceAccess()
  if(!access.session) return <WorkspaceAccessNotice state={access.state}/>
  return <SerialWorkspace key={access.session.tenantId} tenant={access.session.tenantId}/>
}
export default function Page(){
  return <Suspense fallback={<p role="status">Consultando séries…</p>}><Access/></Suspense>
}
