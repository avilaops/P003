import {lotSerials} from "./lot-serials.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { nextRevision,parseRevision,revisionValue } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { conflict } from "../orders/acceptance.js"
import type { CommandHeaders } from "../orders/receivables.js"
import { applyPartialReturn,matchItems,type ReturnInput } from "./partial-return.js"

type Policy={revision:string;windowDays:number|null;approvalAboveCents:string|null}
export async function returnPolicy(c:AuthorizedContext) {
  const row=(await c.client.query<Policy>('SELECT revision,window_days AS "windowDays",approval_above_cents::text AS "approvalAboveCents" FROM sales_return_policies WHERE tenant_id=$1',[c.tenantId])).rows[0]
  return {tenantId:c.tenantId,revision:revisionValue(row?.revision ?? 1),windowDays:row?.windowDays ?? null,approvalAboveCents:row?.approvalAboveCents ?? null,canEdit:c.permissions.includes("sales.approvals.director")}
}
export function registerReturnPolicy(app:FastifyInstance,deps:AccessDependencies) {
  const path="/api/v1/fiscal/return-policy"
  app.get(path,async(r,reply)=>authorizeRequest(r,deps,async c=>{
    requirePermission(c,"sales.orders.read")
    const v=await returnPolicy(c)
    return reply.header("cache-control","no-store").header("etag",'"'+v.revision+'"').send(v)
  }))
  app.put(path,async(r,reply)=>{
    const saved=await authorizeRequest(r,deps,async c=>{
      requirePermission(c,"sales.orders.read");requirePermission(c,"sales.approvals.director")
      const parsed=z.strictObject({windowDays:z.number().int().min(0).max(3650).nullable(),approvalAboveCents:z.string().regex(/^(0|[1-9]\d{0,14})$/).nullable()}).safeParse(r.body)
      if(!parsed.success)throw new Problem(422,"invalid_input","Confira o prazo e o limite de aprovação de devoluções")
      const revision=parseRevision(r.headers["if-match"]),key=commandKey(r.headers["idempotency-key"]),input={...parsed.data,revision}
      const scope="sales.return.policy.updated"
      const previous=await replay(c,key,scope,input)
      if(previous)return previous
      if((await returnPolicy(c)).revision!==revision)throw new Problem(412,"revision_conflict","A política de devolução mudou")
      await c.client.query(`INSERT INTO sales_return_policies(tenant_id,revision,window_days,approval_above_cents) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,window_days=excluded.window_days,approval_above_cents=excluded.approval_above_cents,updated_at=now()`,[c.tenantId,nextRevision(revision),input.windowDays,input.approvalAboveCents])
      const v=await returnPolicy(c)
      await record(c,r.headers,"sales_return_policy",c.tenantId,scope,v)
      await remember(c,key,scope,input,v)
      return v
    })
    return reply.header("cache-control","no-store").header("etag",'"'+saved.revision+'"').send(saved)
  })
}

export function returnReviewer(c:AuthorizedContext) {
  return c.permissions.includes("sales.approvals.manage") || c.permissions.includes("sales.approvals.director")
}
export async function submitReturn(c:AuthorizedContext,headers:CommandHeaders,order:string,input:ReturnInput,digest:string) {
  const policy=await returnPolicy(c)
  const row=(await c.client.query(`SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date-(delivered_at AT TIME ZONE 'America/Sao_Paulo')::date) AS days
    FROM sales_invoice_lots WHERE tenant_id=$1 AND id=$2 AND order_id=$3`,[c.tenantId,input.lotId,order])).rows[0]
  if(policy.windowDays!==null && (row?.days==null || Number(row.days)>policy.windowDays))conflict("O prazo de devolução contado da entrega deste lote expirou")
  if((await c.client.query("SELECT id FROM sales_return_requests WHERE tenant_id=$1 AND received_id=$2 AND status='pending'",[c.tenantId,input.receivedId])).rows.length)conflict("Esta nota de entrada já aguarda decisão")
  if((await c.client.query("SELECT id FROM sales_self_return_plans WHERE tenant_id=$1 AND lot_id=$2 AND status IN('pending','ready')",[c.tenantId,input.lotId])).rows.length)conflict("Conclua ou libere a nota de entrada própria em andamento para este lote")
  const items=await matchItems(c,order,input,digest),amount=items.reduce((s,i)=>s+BigInt(i.value),0n)
  if(policy.approvalAboveCents===null || amount<=BigInt(policy.approvalAboveCents))return {id:await applyPartialReturn(c,headers,order,input,items),status:"applied"}
  await lotSerials(c,order,input.lotId,"return",items,input.serials)
  const id=randomUUID()
  await c.client.query(`INSERT INTO sales_return_requests(tenant_id,id,order_id,lot_id,received_id,xml_sha256,reason,destination,amount_cents,policy_revision,requested_by,serial_selection)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,[c.tenantId,id,order,input.lotId,input.receivedId,digest,input.reason,input.destination,amount,policy.revision,c.authSubject,JSON.stringify(input.serials??[])])
  return {id,status:"pending"}
}

export async function pendingReturn(c:AuthorizedContext,order:string,id:string) {
  if(!returnReviewer(c))throw new Problem(403,"forbidden","A decisão exige alçada de aprovação")
  const row=(await c.client.query<ReturnInput & {digest:string;requestedBy:string;amount:string}>(`SELECT lot_id AS "lotId",received_id::text AS "receivedId",reason,destination,
    xml_sha256 AS digest,requested_by AS "requestedBy",amount_cents::text AS amount,serial_selection AS serials FROM sales_return_requests
    WHERE tenant_id=$1 AND order_id=$2 AND id=$3 AND status='pending'`,[c.tenantId,order,id])).rows[0]
  if(!row)throw new Problem(409,"domain_conflict","Solicitação indisponível ou já decidida")
  if(row.requestedBy===c.authSubject)throw new Problem(403,"forbidden","Outra pessoa deve decidir esta devolução")
  return row
}
export async function decideReturn(c:AuthorizedContext,headers:CommandHeaders,order:string,id:string,approve:boolean,reason:string,digest:string) {
  const req=await pendingReturn(c,order,id)
  let returned:string|null=null
  if(approve){
    if(req.digest!==digest)conflict("O XML de entrada mudou desde a solicitação")
    const items=await matchItems(c,order,req,digest)
    if(items.reduce((s,i)=>s+BigInt(i.value),0n)!==BigInt(req.amount))conflict("O valor conciliável mudou desde a solicitação")
    returned=await applyPartialReturn(c,headers,order,req,items)
  }
  const status=approve?"approved":"rejected"
  await c.client.query("UPDATE sales_return_requests SET status=$3,decision_by=$4,decided_at=now(),decision_reason=$5,return_id=$6 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,status,c.authSubject,reason,returned])
  return {id,status}
}
