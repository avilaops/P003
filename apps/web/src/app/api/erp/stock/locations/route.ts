import { forwardErp } from "@/server/bff/erp-proxy"
export const GET = (request: Request) => forwardErp(request, "/stock/locations")
export const PUT = (request: Request) => forwardErp(request, "/stock/locations")
