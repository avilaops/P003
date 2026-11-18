import { forwardErp } from "@/server/bff/erp-proxy"

async function handle(request:Request, {params}:{params:Promise<{id:string}>}) {
  return forwardErp(request,`/warranty-cases/${(await params).id}/records`)
}
export { handle as GET, handle as POST }
