import { forwardErp } from "@/server/bff/erp-proxy"

export async function GET(request: Request, { params }: { params: Promise<{ entity: string }> }) {
  return forwardErp(request, `/data-quality/${(await params).entity}/completeness`)
}
