import {Suspense} from "react"
import {connection} from "next/server"
import {currentWorkspaceAccess,WorkspaceAccessNotice} from "@/features/access/workspace-access"
import {Replenishment} from "./replenishment"

type Props = { params?: Promise<{id:string}> }

async function Content({params}:Props) {
  await connection()
  const access=await currentWorkspaceAccess()
  if(!access.session) return <WorkspaceAccessNotice state={access.state}/>
  return <Replenishment key={access.session.tenantId} tenant={access.session.tenantId} id={(await params)?.id}/>
}

export function ReplenishmentPage(props:Props) {
  return <Suspense fallback={<p role="status">Consultando reposição…</p>}><Content {...props}/></Suspense>
}
