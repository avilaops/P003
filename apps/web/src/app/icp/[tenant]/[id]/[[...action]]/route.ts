import { participantPortal } from "@/server/contracts/participant-portal"
import { typescriptOrigin } from "@/server/bff/erp-backend"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ tenant: string; id: string; action?: string[] }> }
export async function GET(request: Request, { params }: Context) {
  return participantPortal(request, await params, () => typescriptOrigin({ ERP_TYPESCRIPT_API_URL: process.env.ERP_TYPESCRIPT_API_URL }))
}
export const POST = GET
