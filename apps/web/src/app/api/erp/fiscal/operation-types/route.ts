import { forwardFiscal } from "@/server/bff/erp-fiscal-proxy"

export const GET = (request: Request) => forwardFiscal(request, "/operation-types")
export const POST = (request: Request) => forwardFiscal(request, "/operation-types")
