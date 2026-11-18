import {forwardErp} from "@/server/bff/erp-proxy"
export async function GET(request:Request,{params}:{params:Promise<{action:string}>}){
  if((await params).action!=="basis") return Response.json({title:"Consulta desconhecida"},{status:404})
  return forwardErp(request,"/stock/periods/basis")
}
export async function POST(request:Request,{params}:{params:Promise<{action:string}>}){
  const {action}=await params
  if(!["close","reopen","recalculate","basis"].includes(action)) return Response.json({title:"Operação desconhecida"},{status:404})
  return forwardErp(request,"/stock/periods/"+action)
}
