import { forwardFiscal } from "@/server/bff/erp-fiscal-proxy"

type Context = { params: Promise<{ id: string }> }
async function forward(request: Request, context: Context) {
  const { id } = await context.params
  return forwardFiscal(request, `/operation-types/${encodeURIComponent(id)}`)
}
export const GET = forward
export const PUT = forward
