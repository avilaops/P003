import {forwardErp} from "@/server/bff/erp-proxy"
type Context={params:Promise<{kind:string;id:string}>}
async function proxy(req:Request,{params}:Context){
  const {kind,id}=await params
  return forwardErp(req,"/stock/document-locations/"+kind+"/"+id)
}
export {proxy as GET,proxy as PUT}
