import { forwardErp } from "@/server/bff/erp-proxy"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return forwardErp(request, `/commercial-contracts/${id}/qualified-reissue`)
}

export const POST = GET
