import {forwardErp} from "@/server/bff/erp-proxy"
type Context={params:Promise<{id:string}>}
export async function GET(req:Request,{params}:Context){return forwardErp(req,"/stock/replenishment/"+(await params).id)}
export async function PUT(req:Request,{params}:Context){return forwardErp(req,"/stock/replenishment/"+(await params).id)}
