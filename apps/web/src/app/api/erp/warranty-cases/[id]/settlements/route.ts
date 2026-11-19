import { forwardErp } from "@/server/bff/erp-proxy"
async function forward(request: Request, {params}:{params:Promise<{id:string}>}) {
  return forwardErp(request,`/warranty-cases/${(await params).id}/settlements`)
}
export { forward as GET, forward as POST }
