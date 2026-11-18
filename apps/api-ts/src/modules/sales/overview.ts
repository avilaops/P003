import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest,type AccessDependencies,type AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { listReviews } from "../commercial/reviews.js"
import { queryInteger } from "../registrations/query.js"

const groups=["open-proposals","month-orders","conversion","approvals","stale-orders","stale-proposals","expiring"] as const
type Group=typeof groups[number]
const day="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
const orderRows=`SELECT 'pedidos' AS kind,id,number::text,customer_name AS customer,amount_cents AS amount,status,created_at AS date,false AS converted
 FROM sales_orders WHERE tenant_id=$1 AND `
const proposalRows=`SELECT 'propostas' AS kind,p.id,p.number::text,v.customer_name AS customer,v.amount_cents AS amount,v.status,
 p.updated_at AS date,p.order_id IS NOT NULL AS converted FROM sales_proposals p
 JOIN sales_proposal_versions v ON (v.tenant_id,v.proposal_id,v.version)=(p.tenant_id,p.id,p.current_version) WHERE p.tenant_id=$1 AND `
const populations:Record<Exclude<Group,"approvals">,string>={
  "open-proposals":proposalRows+"v.status IN ('draft','sent')",
  "month-orders":orderRows+`status<>'cancelled' AND created_at BETWEEN (date_trunc('month',${day}::timestamp) AT TIME ZONE 'America/Sao_Paulo') AND now()`,
  "conversion":proposalRows+`(SELECT MIN(first.sent_at) FROM sales_proposal_versions first WHERE (first.tenant_id,first.proposal_id)=(p.tenant_id,p.id)) BETWEEN ((${day}-89)::timestamp AT TIME ZONE 'America/Sao_Paulo') AND now()`,
  "stale-orders":orderRows+"status='draft' AND updated_at<now()-interval '7 days'",
  "stale-proposals":proposalRows+"v.status='draft' AND p.updated_at<now()-interval '7 days'",
  "expiring":proposalRows+"v.status='sent' AND v.valid_until<="+day+"+7",
}
const query=z.strictObject({group:z.enum(groups).optional(),offset:queryInteger(0,100000).default(0),limit:queryInteger(1,100).default(25)})
function visible(ctx:AuthorizedContext,key:Group) {
  if(key==="approvals") return ctx.permissions.includes("sales.orders.read") || ctx.permissions.includes("sales.proposals.read")
  return ctx.permissions.includes(["month-orders","stale-orders"].includes(key)?"sales.orders.read":"sales.proposals.read")
}
async function section(ctx:AuthorizedContext,group:Group,details:boolean,offset:number,limit:number) {
  if(group==="approvals") {
    const pending=await listReviews(ctx)
    return {group,total:pending.length,converted:0,amountCents:pending.reduce((n,item)=>n+BigInt(item.amountCents),0n).toString(),
      data:details?pending.slice(offset,offset+limit).map(row=>({kind:row.kind==="proposal"?"propostas":"pedidos",id:row.documentId,number:row.number,customer:row.customer,amount:row.amountCents,status:"pending",date:row.dueAt})):[]}
  }
  const page=details?`(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.date DESC,p.id),'[]') FROM (SELECT * FROM population ORDER BY date DESC,id LIMIT $2 OFFSET $3) p)`:"'[]'::jsonb"
  const stmt="WITH population AS ("+populations[group]+") SELECT count(*)::int AS total,count(*) FILTER (WHERE converted)::int AS converted,coalesce(sum(amount),0)::text AS cents,"+page+" AS data FROM population"
  const row=(await ctx.client.query(stmt,details?[ctx.tenantId,limit,offset]:[ctx.tenantId])).rows[0]!
  return {group,total:Number(row.total),converted:Number(row.converted),amountCents:String(row.cents),data:row.data}
}
export function registerSalesOverview(app:FastifyInstance,deps:AccessDependencies) {
  app.get("/api/v1/sales/overview",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async ctx=>{
      const f=query.safeParse(req.query)
      if(!f.success) throw new Problem(422,"invalid_input","Filtros do indicador inválidos")
      const {group,limit,offset}=f.data
      const allowed=groups.filter(key=>visible(ctx,key))
      if(!allowed.length || group && !allowed.includes(group)) throw new Problem(403,"forbidden","Indicador indisponível para este perfil")
      const sections=[]
      for(const key of group?[group]:allowed) sections.push(await section(ctx,key,Boolean(group),offset,limit))
      return {tenantId:ctx.tenantId,sections,offset,limit}
    })
    return reply.header("cache-control","no-store").send(result)
  })
}
