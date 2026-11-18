import { forwardFiscal } from "@/server/bff/erp-fiscal-proxy"

async function email(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return forwardFiscal(request, `/received-nfses/${id}/email`)
}

export { email as GET, email as POST }
