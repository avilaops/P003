import { forwardErp } from "@/server/bff/erp-proxy"

type Context = { params: Promise<{ code: string }> }
async function parameter(request: Request, { params }: Context) {
  const { code } = await params
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(code) || code.length > 120) return Response.json({ title: "Parâmetro inválido" }, { status: 404 })
  return forwardErp(request, `/parameters/${code}`)
}
export { parameter as GET, parameter as PUT }
