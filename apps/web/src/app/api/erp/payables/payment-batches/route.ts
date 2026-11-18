import { forwardErp } from "@/server/bff/erp-proxy"
export const POST = (request: Request) => forwardErp(request, "/payables/payment-batches")
