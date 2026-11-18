import { forwardErp } from "@/server/bff/erp-proxy"
export function GET(req:Request) {return forwardErp(req,"/opportunities/settings")}
export function PUT(req:Request) {return forwardErp(req,"/opportunities/settings")}
