import { forwardErp } from "@/server/bff/erp-proxy"

export function GET(request:Request) { return forwardErp(request,"/warranty-policies") }

export function POST(request:Request) { return forwardErp(request,"/warranty-policies") }
