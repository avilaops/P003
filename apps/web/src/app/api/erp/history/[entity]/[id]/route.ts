import { forwardErp } from "@/server/bff/erp-proxy"

export async function GET(request: Request, { params }: { params: Promise<{ entity: string; id: string }> }) {
  const { entity, id } = await params
  return forwardErp(request, `/history/${entity}/${id}`)
}
