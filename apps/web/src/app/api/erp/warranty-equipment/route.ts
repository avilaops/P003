import { forwardErp } from "@/server/bff/erp-proxy"

export function GET(request:Request) { return forwardErp(request,"/warranty-equipment") }

export function POST(request:Request) { return forwardErp(request,"/warranty-equipment") }
