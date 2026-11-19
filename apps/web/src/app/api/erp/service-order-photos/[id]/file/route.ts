import { forwardErp } from "@/server/bff/erp-proxy"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ title: "Recurso inválido" }, { status: 404 })
  return forwardErp(request, `/service-order-photos/${id}/file`)
}
