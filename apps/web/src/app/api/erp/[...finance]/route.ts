import { financeRoute } from "@/server/bff/finance-resources"
import { forwardErp } from "@/server/bff/erp-proxy"

type Context = { params: Promise<{ finance: string[] }> }
async function finance(request: Request, { params }: Context) {
  const parts = (await params).finance
  if (parts.some(part => !/^[a-z0-9-]+$/i.test(part))) return Response.json({ title: "Recurso inválido" }, { status: 404 })
  const resource = "/" + parts.join("/")
  if (!financeRoute(request.method, resource)) return Response.json({ title: "Recurso financeiro indisponível" }, { status: 404 })
  return forwardErp(request,resource)
}
export { finance as GET, finance as POST, finance as PUT }
