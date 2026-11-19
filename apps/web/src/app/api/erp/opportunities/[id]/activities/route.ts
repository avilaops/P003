import { forwardErp } from "@/server/bff/erp-proxy"
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}) {return forwardErp(req,`/opportunities/${(await params).id}/activities`)}
