import { forwardErp } from "@/server/bff/erp-proxy"
import { salesPolicyResource } from "@/server/bff/erp-backend"

async function handle(request:Request, {params}:{params:Promise<{path:string[]}>}){
 const resource="/commercial/policies/"+(await params).path.join("/")
 if(!salesPolicyResource(request.method,resource)) return Response.json({title:"Operação inválida"},{status:404})
 return forwardErp(request,resource)
}
export {handle as GET,handle as POST}
