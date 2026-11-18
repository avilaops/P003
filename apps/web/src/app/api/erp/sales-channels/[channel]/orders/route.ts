import { forwardErp } from "@/server/bff/erp-proxy"

export async function GET(request: Request, { params }: { params: Promise<{ channel: string }> }) {
  return forwardErp(request, `/sales-channels/${(await params).channel}/orders`)
}
