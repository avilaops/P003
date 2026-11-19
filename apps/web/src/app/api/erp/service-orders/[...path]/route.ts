import { forwardErp } from "@/server/bff/erp-proxy"

type Context = { params: Promise<{ path: string[] }> }
async function serviceOrders(request: Request, { params }: Context) {
  const parts = (await params).path
  if (parts.some(part => !/^[a-z0-9-]+$/i.test(part))) return Response.json({ title: "Recurso inválido" }, { status: 404 })
  return forwardErp(request, "/service-orders/" + parts.join("/"))
}
export { serviceOrders as GET, serviceOrders as POST }
