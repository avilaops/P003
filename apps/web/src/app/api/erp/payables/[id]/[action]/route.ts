import { financeRoute } from "@/server/bff/finance-resources"
import { forwardErp } from "@/server/bff/erp-proxy"

type Context = { params: Promise<{ id: string; action: string }> }
async function handle(request: Request, {params}: Context) {
  const {id,action} = await params
  const resource = `/payables/${id}/${action}`
  if (!financeRoute(request.method, resource)) return Response.json({title:"Recurso financeiro indisponível"},{status:404})
  return forwardErp(request, resource)
}
export { handle as GET, handle as POST, handle as PUT }
