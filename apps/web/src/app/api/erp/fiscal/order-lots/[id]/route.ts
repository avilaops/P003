import { forwardFiscal } from "@/server/bff/erp-fiscal-proxy"

type Context = { params: Promise<{id:string}> }
export async function GET(request:Request, {params}:Context) {
  return forwardFiscal(request, "/order-lots/"+(await params).id)
}
export const POST = GET
