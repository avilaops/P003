import { forwardErp } from "@/server/bff/erp-proxy"
export async function POST(req:Request,{params}:{params:Promise<{id:string;activityId:string}>}) {const {id,activityId}=await params;return forwardErp(req,`/opportunities/${id}/activities/${activityId}/complete`)}
