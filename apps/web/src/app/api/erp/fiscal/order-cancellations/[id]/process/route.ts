import { forwardFiscal } from "@/server/bff/erp-fiscal-proxy"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return forwardFiscal(request, `/order-cancellations/${(await params).id}/process`)
}

export const POST=GET
