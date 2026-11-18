import { contractTemplatesProxy } from "@/server/bff/contracts-proxy"
export async function POST(request: Request, context: RouteContext<"/api/erp/contract-template-drafts/[id]/archive">) {
  const { id } = await context.params
  return contractTemplatesProxy(request, `/${id}/archive`)
}
