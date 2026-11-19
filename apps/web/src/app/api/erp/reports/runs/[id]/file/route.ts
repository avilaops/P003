import { forwardErp } from "@/server/bff/erp-proxy"

type Context = RouteContext<"/api/erp/reports/runs/[id]/file">
async function forward(request: Request, context: Context) {
  const { id } = await context.params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ title: "Registro inválido" }, { status: 404 })
  return forwardErp(request, `/reports/runs/${id}/file`)
}
export const GET = forward
