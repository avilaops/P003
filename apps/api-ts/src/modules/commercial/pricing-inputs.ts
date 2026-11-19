import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"

import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { parametersSchema, simulateParameters } from "./parameters.js"
import { registerPricePublication, suggestedDownPayment } from "./publication.js"
import { lineSchema, lockPricingSnapshot, pricingInput, publicationManager, stale } from "./pricing-validation.js"
import { monthlyExpenses, registerPricingExpenses } from "./pricing-expenses.js"

const costsSchema = z.strictObject({
  productLine: lineSchema,
  purchaseCostCents: z.number().int().min(0).max(1_000_000_000_000),
  taxCreditBps: z.number().int().min(0).max(10000),
  packagingCents: z.number().int().min(0).max(1_000_000_000_000),
})

async function auditSettings(c: AuthorizedContext, entity: "commercial_settings" | "product_costs", details: object) {
  await c.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,details) SELECT $1,id,$3,$4,$5 FROM identities WHERE auth_subject=$2",
    [c.tenantId,c.authSubject,entity + ".updated",entity,details])
}

function sendSnapshot(reply: FastifyReply, body: { revision: Revision }) {
  return reply.header("cache-control", "no-store").header("etag", '"' + body.revision + '"').send(body)
}

async function settingsSnapshot(context: AuthorizedContext, line: string, revision: Revision, raw: unknown) {
  const monthlyExpensesCents = await monthlyExpenses(context)
  const parameters = raw === null ? null : { ...pricingInput(parametersSchema,raw), monthlyExpensesCents }
  const calculation = parameters && simulateParameters(parameters)
  const suggestion = parameters && calculation && await suggestedDownPayment(context,line,parameters,calculation.variableCostsBps)
  return { tenantId: context.tenantId, line, revision, data: parameters, calculation, suggestedDownPayment: suggestion, monthlyExpensesCents, status: "draft", canEdit: true }
}

async function productCosts(context: AuthorizedContext, id: string) {
  const result = await context.client.query(`SELECT p.name,coalesce(c.revision,1) AS revision,CASE WHEN c.product_id IS NOT NULL THEN
      jsonb_build_object('productLine',c.product_line,'purchaseCostCents',c.purchase_cost_cents,'taxCreditBps',c.tax_credit_bps,'packagingCents',c.packaging_cents) END AS data
    FROM products p LEFT JOIN product_costs c ON c.tenant_id=p.tenant_id AND c.product_id=p.id WHERE p.tenant_id=$1 AND p.id=$2`,[context.tenantId,id])
  const row = result.rows[0]
  if (!row) throw new Problem(404,"not_found","Produto não encontrado nesta empresa")
  return { tenantId: context.tenantId, productId: id, productName: row.name, revision: revisionValue(row.revision), canEdit: true, data: row.data }
}

export function registerCommercialPricingSettings(app: FastifyInstance,deps: AccessDependencies) {
  registerPricePublication(app,deps)
  registerPricingExpenses(app,deps)
  const settings = "/api/v1/commercial-settings/:line", costs = "/api/v1/product-costs/:id"
  app.get<{Params:{line:string}}>(settings, async (req,reply) => {
    const result = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      const line = pricingInput(lineSchema,req.params.line)
      await lockPricingSnapshot(c)
      const row = (await c.client.query("SELECT revision,parameters FROM commercial_settings WHERE tenant_id=$1 AND product_line=$2",[c.tenantId,line])).rows[0]
      return settingsSnapshot(c,line,revisionValue(row?.revision ?? 1),row?.parameters ?? null)
    })
    return sendSnapshot(reply,result)
  })
  app.post<{Params:{line:string}}>(settings+"/preview", async (req,reply) => {
    const result = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      const line = pricingInput(lineSchema,req.params.line)
      await lockPricingSnapshot(c)
      const snapshot = await settingsSnapshot(c,line,1,pricingInput(parametersSchema,req.body))
      return {tenantId:c.tenantId,line,calculation:snapshot.calculation,suggestedDownPayment:snapshot.suggestedDownPayment}
    },false)
    return reply.header("cache-control","no-store").send(result)
  })
  app.put<{Params:{line:string}}>(settings, async (req,reply) => {
    const result = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      const line = pricingInput(lineSchema,req.params.line), expected = parseRevision(req.headers["if-match"])
      const row = (await c.client.query("SELECT revision FROM commercial_settings WHERE tenant_id=$1 AND product_line=$2",[c.tenantId,line])).rows[0]
      if(revisionValue(row?.revision ?? 1) !== expected) stale()
      const revision = nextRevision(expected)
      const snapshot = await settingsSnapshot(c,line,revision,pricingInput(parametersSchema,req.body))
      await c.client.query(`INSERT INTO commercial_settings(tenant_id,product_line,revision,parameters) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,product_line) DO UPDATE SET revision=excluded.revision,parameters=excluded.parameters,updated_at=now()`,[c.tenantId,line,revision,snapshot.data])
      await auditSettings(c,"commercial_settings",{line,previousRevision:expected,revision})
      return snapshot
    })
    return sendSnapshot(reply,result)
  })
  app.get<{Params:{id:string}}>(costs, async (req,reply) => {
    const result = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      return productCosts(c,pricingInput(z.guid(),req.params.id).toLowerCase())
    })
    return sendSnapshot(reply,result)
  })
  app.put<{Params:{id:string}}>(costs, async (req,reply) => {
    const result = await authorizeRequest(req,deps,async c => {
      requirePermission(c,publicationManager)
      const id = pricingInput(z.guid(),req.params.id).toLowerCase(), expected = parseRevision(req.headers["if-match"])
      const input = pricingInput(costsSchema,req.body), previous = await productCosts(c,id)
      if (previous.revision !== expected) stale()
      const revision = nextRevision(expected)
      await c.client.query(`INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(tenant_id,product_id) DO UPDATE SET product_line=excluded.product_line,purchase_cost_cents=excluded.purchase_cost_cents,tax_credit_bps=excluded.tax_credit_bps,
        packaging_cents=excluded.packaging_cents,revision=excluded.revision,updated_at=now()`,[c.tenantId,id,input.productLine,input.purchaseCostCents,input.taxCreditBps,input.packagingCents,revision])
      await auditSettings(c,"product_costs",{productId:id,previousRevision:expected,revision})
      return {...previous,revision,data:input}
    })
    return sendSnapshot(reply,result)
  })
}
