import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { parseListQuery } from "../registrations/query.js"
import { pricingInput, publicationManager, stale } from "./pricing-validation.js"

const expenseDate = z.iso.date().refine(value => value >= "1900-01-01" && value <= "2100-12-31")
const expenseSchema = z.strictObject({
  description: z.string().trim().refine(value => Array.from(value).length >= 3 && Array.from(value).length <= 200),
  categoryId: z.guid().transform(id => id.toLowerCase()),
  amountCents: z.number().int().min(0).max(1_000_000_000_000),
  startsOn: expenseDate, endsOn: expenseDate.nullish().default(null),
  status: z.enum(["active","archived"]),
}).refine(value => !value.endsOn || value.endsOn >= value.startsOn)

const expenseRows = `SELECT jsonb_build_object('id',e.id,'description',e.description,'categoryId',e.category_id,'categoryName',c.name,
  'amountCents',e.amount_cents,'startsOn',e.starts_on,'endsOn',e.ends_on,'status',e.status,'revision',e.revision) AS data
  FROM fixed_expenses e JOIN financial_categories c ON c.tenant_id=e.tenant_id AND c.id=e.category_id WHERE e.tenant_id=$1`

export async function monthlyExpenses(context: AuthorizedContext) {
  const result = await context.client.query(`SELECT coalesce(sum(amount_cents),0)::bigint AS monthly FROM fixed_expenses
    WHERE tenant_id=$1 AND status='active' AND starts_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date
    AND (ends_on IS NULL OR ends_on>=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date)`,[context.tenantId])
  return revisionValue(result.rows[0]!.monthly)
}

export function registerPricingExpenses(app: FastifyInstance, deps: AccessDependencies) {
  // GET /financial-categories is served by reference-data (full category registry).
  const path = "/api/v1/fixed-expenses"
  app.get(path,async (req,reply) => {
    const body = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      const rows = await c.client.query(expenseRows+" ORDER BY e.description,e.id LIMIT 1001",[c.tenantId])
      if(rows.rows.length > 1000) throw new Problem(422,"invalid_input","Limite de 1000 despesas por empresa")
      return { tenantId:c.tenantId, data:rows.rows.map(row=>row.data),monthlyExpensesCents:await monthlyExpenses(c) }
    })
    return reply.header("cache-control","no-store").send(body)
  })
  async function save(req:FastifyRequest,reply:FastifyReply,rawId:string|null) {
    const result = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      const id = rawId === null ? null : pricingInput(z.guid(),rawId).toLowerCase()
      const key = commandKey(req.headers["idempotency-key"]), expected = id ? parseRevision(req.headers["if-match"]) : null
      const input = pricingInput(expenseSchema,req.body), scope = id ? "fixed_expense.update" : "fixed_expense.create"
      const command = {id,revision:expected,input}
      const saved = await replay(c,key,scope,command)
      if (saved) return saved as {tenantId:string;data:{revision:number|bigint}}
      const category = await c.client.query("SELECT id FROM financial_categories WHERE tenant_id=$1 AND id=$2 AND direction='expense' AND status='active'",[c.tenantId,input.categoryId])
      if (!category.rows.length) throw new Problem(409,"domain_conflict","Selecione uma categoria de despesa ativa")
      const expenseId = id ?? randomUUID()
      const args = [c.tenantId,expenseId,input.description,input.categoryId,input.amountCents,input.startsOn,input.endsOn,input.status]
      let revision:number|bigint = 1
      if(id && expected !== null) {
        const row = (await c.client.query("SELECT revision FROM fixed_expenses WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])).rows[0]
        if(!row) throw new Problem(404,"not_found","Despesa não encontrada nesta empresa")
        if(revisionValue(row.revision) !== expected) stale()
        revision = nextRevision(expected)
        await c.client.query("UPDATE fixed_expenses SET description=$3,category_id=$4,amount_cents=$5,starts_on=$6,ends_on=$7,status=$8,revision=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2",[...args,revision])
      } else {
        const count = await c.client.query("SELECT count(*) AS total FROM fixed_expenses WHERE tenant_id=$1",[c.tenantId])
        if (Number(count.rows[0]!.total) >= 1000) throw new Problem(422,"invalid_input","Limite de 1000 despesas por empresa")
        await c.client.query("INSERT INTO fixed_expenses(tenant_id,id,description,category_id,amount_cents,starts_on,ends_on,status,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)",args)
      }
      await record(c,req.headers,"fixed_expense",expenseId,id?"fixed_expense.updated":"fixed_expense.created",{revision,status:input.status})
      const row = await c.client.query<{data:{revision:number|bigint}}>(expenseRows+" AND e.id=$2",[c.tenantId,expenseId])
      const body = {tenantId:c.tenantId,data:row.rows[0]!.data}
      await remember(c,key,scope,command,body)
      return body
    })
    return reply.code(rawId ? 200 : 201).header("cache-control","no-store").header("etag",'"'+result.data.revision+'"').send(result)
  }
  app.post(path,(req,reply)=>save(req,reply,null))
  app.put<{Params:{id:string}}>(path+"/:id",(req,reply)=>save(req,reply,req.params.id))
}
