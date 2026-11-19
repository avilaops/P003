import type { AuthorizedContext } from "../../platform/access.js"
import { requirePermission } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, revisionValue, type Revision } from "../../platform/revision.js"

type Headers=Parameters<typeof record>[1]
export async function linkNewProposal(c:AuthorizedContext,headers:Headers,source:{id:string;revision:number},proposal:string,customer:string) {
  requirePermission(c,"sales.orders.read")
  requirePermission(c,"sales.orders.manage")
  const row=(await c.client.query("SELECT customer_id,revision,proposal_id,order_id,data->>'stage' AS stage FROM sales_opportunities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[c.tenantId,source.id])).rows[0]
  if(!row) throw new Problem(404,"not_found","Oportunidade não encontrada nesta empresa")
  if(revisionValue(row.revision)!==source.revision) throw new Problem(412,"revision_conflict","A oportunidade mudou. Confira o detalhe antes de criar a proposta")
  if(row.proposal_id || row.order_id || ["won","lost"].includes(String(row.stage)) || row.customer_id && row.customer_id!==customer) {
    throw new Problem(409,"domain_conflict","A oportunidade precisa estar aberta, com o mesmo cliente e sem documento vinculado")
  }
  const revision=nextRevision(source.revision)
  await c.client.query("UPDATE sales_opportunities SET customer_id=$3,proposal_id=$4,revision=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,source.id,customer,proposal,revision])
  await record(c,headers,"sales_opportunity",source.id,"opportunity.proposal_linked",{revision,proposalId:proposal})
}
export async function preserveLinkedCustomer(c:AuthorizedContext,proposal:string,customer:string) {
  const other=(await c.client.query("SELECT 1 FROM sales_opportunities WHERE tenant_id=$1 AND proposal_id=$2 AND customer_id IS DISTINCT FROM $3",[c.tenantId,proposal,customer])).rows[0]
  if(other) throw new Problem(409,"domain_conflict","Preserve o cliente da oportunidade vinculada")
}
export async function advanceLinkedProposal(c:AuthorizedContext,headers:Headers,proposal:string,stage:"proposed"|"won",order?:string) {
  const row=(await c.client.query<{id:string;revision:Revision;stage:string}>("SELECT id,revision,data->>'stage' AS stage FROM sales_opportunities WHERE tenant_id=$1 AND proposal_id=$2",[c.tenantId,proposal])).rows[0]
  if(!row) return
  if(row.stage==="lost") throw new Problem(409,"domain_conflict","Reabra a oportunidade perdida antes de avançar com a proposta")
  const revision=nextRevision(revisionValue(row.revision))
  await c.client.query("UPDATE sales_opportunities SET data=jsonb_set(data,'{stage}',to_jsonb($3::text)),order_id=COALESCE($4,order_id),revision=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,row.id,stage,order,revision])
  await record(c,headers,"sales_opportunity",row.id,order?"opportunity.order_linked":"opportunity.proposal_sent",{revision,stage,proposalId:proposal,...(order?{orderId:order}:{})})
}
