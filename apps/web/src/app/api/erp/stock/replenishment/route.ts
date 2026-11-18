import {forwardErp} from "@/server/bff/erp-proxy"
export const GET=(req:Request)=>forwardErp(req,"/stock/replenishment")
