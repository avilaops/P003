import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { withTenantTransaction } from "../../platform/database.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { chargeSchema, collections, getCharge, observePayment, reserveCharge } from "./collections.js"
import { batchQuery, cancelBatch, cancelBatchSchema, prepareBatch, prepareBatchSchema, readBatches } from "./collection-batches.js"
import { listProviderReports, prepareProviderImport, remoteReportId, reportMerchant } from "./provider-reports.js"
import { checkSignature, getPayment, issue, providerCents, requirePilot, settlementReport } from "./mercadopago.js"
import {
  conflict,
  entrySchema,
  insertEntry,
  invalid,
  ledgerQuery,
  loadLedger,
  missing,
  parse,
  transfer,
  transferSchema,
} from "./ledger.js"
import {
  classifyAndMatch,
  classifySchema,
  exception,
  exceptionSchema,
  importSchema,
  importStatement,
  match,
  matchSchema,
  period,
  periodSchema,
  reconciliation,
  reconciliationQuery,
} from "./reconciliation.js"

export function registerFinanceTreasuryRoutes(app: FastifyInstance, deps: AppDependencies) {
  const root = "/api/v1/",
    treasury = root + "finance-treasury/"
  function read<T>(
    url: string,
    readPerm: string,
    managePerm: string,
    fn: (ctx: AuthorizedContext, request: FastifyRequest) => Promise<T>,
  ) {
    app.get(url, async (request, reply) => {
      const result = await authorizeRequest(request, deps, async (ctx) => {
        requirePermission(ctx, readPerm)
        return { tenantId: ctx.tenantId, canEdit: ctx.permissions.includes(managePerm), data: await fn(ctx, request) }
      })
      return reply.header("cache-control", "no-store").send(result)
    })
  }
  function command<T>(
    url: string,
    schema: z.ZodType<T>,
    readPerm: string,
    writePerm: string,
    scope: string,
    fn: (
      ctx: AuthorizedContext,
      input: T,
    ) => Promise<{ id: string; result: Record<string, unknown>; details: unknown }>,
    file = false,
  ) {
    app.post(url, { bodyLimit: file ? 2_200_000 : 65_536 }, async (request, reply) => {
      const key = commandKey(request.headers["idempotency-key"])
      const output = await authorizeRequest(request, deps, async (ctx) => {
        requirePermission(ctx, readPerm)
        requirePermission(ctx, writePerm)
        const input = parse(schema, request.body)
        const commandInput = file
          ? {
              input: {
                accountId: (input as { accountId: string }).accountId,
                ...((input as {autoMatch?:boolean}).autoMatch ? {autoMatch:true} : {}),
                digest: createHash("sha256")
                  .update((input as { content: string }).content)
                  .digest("hex"),
              },
            }
          : { input }
        const saved = await replay(ctx, key, scope, commandInput)
        if (saved) return { value: saved, replayed: true }
        const mutation = await fn(ctx, input)
        await record(
          ctx,
          request.headers,
          scope.split(".")[0]!,
          mutation.id,
          scope.endsWith(".create") ? scope + "d" : scope,
          mutation.details,
        )
        await remember(ctx, key, scope, commandInput, mutation.result)
        return { value: mutation.result, replayed: false }
      })
      if (output.replayed) reply.header("idempotency-replayed", "true")
      return reply.code(201).header("etag", '"1"').header("cache-control", "no-store").send(output.value)
    })
  }
  const readEntries = "finance.account_entries.read",
    writeEntries = "finance.account_entries.manage"
  read(root + "financial-account-entries", readEntries, writeEntries, (ctx, req) =>
    loadLedger(ctx, parse(ledgerQuery, req.query)),
  )
  command(
    root + "financial-account-entries",
    entrySchema,
    readEntries,
    writeEntries,
    "financial_account_entry.create",
    insertEntry,
  )
  command(
    root + "financial-account-transfers",
    transferSchema,
    "finance.account_transfers.read",
    "finance.account_transfers.manage",
    "financial_account_transfer.create",
    transfer,
  )
  read(treasury + "reconciliation", readEntries, writeEntries, (ctx, req) =>
    reconciliation(ctx, parse(reconciliationQuery, req.query)),
  )
  command(
    treasury + "import-ofx",
    importSchema,
    readEntries,
    writeEntries,
    "finance_statement.imported",
    importStatement,
    true,
  )
  command(
    treasury + "import-cnab",
    importSchema,
    readEntries,
    writeEntries,
    "finance_statement.efi_imported",
    (ctx, input) => importStatement(ctx, input, "efi"),
    true,
  )
  command(treasury + "match", matchSchema, readEntries, writeEntries, "finance_reconciliation.matched", match)
  command(treasury + "classify-movement", classifySchema, readEntries, writeEntries, "finance_reconciliation.movement_classified", classifyAndMatch)
  command(
    treasury + "exception",
    exceptionSchema,
    readEntries,
    writeEntries,
    "finance_reconciliation.exception",
    exception,
  )
  command(
    treasury + "close-period",
    periodSchema,
    readEntries,
    "finance.reconciliation.close",
    "finance_period.closed",
    (ctx, input) => period(ctx, input, false),
  )
  command(
    treasury + "reopen-period",
    periodSchema,
    readEntries,
    "finance.reconciliation.reopen",
    "finance_period.reopened",
    (ctx, input) => period(ctx, input, true),
  )
  const readCharges = "finance.collections.read",
    writeCharges = "finance.collections.manage"
  read(treasury + "batches", readCharges, writeCharges, (ctx, req) => readBatches(ctx, parse(batchQuery, req.query)))
  command(treasury + "prepare-batch", prepareBatchSchema, readCharges, writeCharges, "finance_collection_batch.prepared", prepareBatch)
  command(treasury + "cancel-batch", cancelBatchSchema, readCharges, writeCharges, "finance_collection_batch.cancelled", cancelBatch)
  read(treasury + "collections", readCharges, writeCharges, (ctx, request) => {
    requirePermission(ctx, "finance.receivables.read")
    return collections(ctx, parse(z.strictObject({ groupId: z.guid().optional() }), request.query).groupId)
  })
  function bankRights(ctx: AuthorizedContext) {
    requirePermission(ctx, writeCharges)
    requirePermission(ctx, "finance.receivables.read")
    requirePermission(ctx, "finance.receivables.manage")
  }
  app.post(treasury + "issue-charge", async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"]),
      input = parse(chargeSchema, req.body)
    const reservation = await authorizeRequest(req, deps, async (ctx) => {
      bankRights(ctx)
      const saved = await replay(ctx, key, "finance_collection.reserve", { input })
      const id = saved ? String(saved.chargeId) : await reserveCharge(ctx, req.headers, input, key)
      if (!saved) await remember(ctx, key, "finance_collection.reserve", { input }, { chargeId: id })
      return { tenantId: ctx.tenantId, charge: await getCharge(ctx, id) }
    })
    const { charge, tenantId } = reservation
    if (charge.provider_id)
      return reply
        .header("etag", '"1"')
        .send({ tenantId, data: { chargeId: charge.id, state: charge.state, instructions: charge.instructions } })
    const cfg = requirePilot(tenantId, input.accountId)
    if (cfg.live !== charge.live_mode || cfg.collectorId !== charge.collector_id)
      throw conflict("O vínculo atual diverge do ambiente e vendedor desta cobrança")
    const payment = await issue(cfg, charge.provider_request, charge.id)
    const data = await authorizeRequest(req, deps, async (ctx) => {
      bankRights(ctx)
      return observePayment(ctx, req.headers, await getCharge(ctx, charge.id), payment, "issuance", charge.id)
    })
    return reply.code(201).header("etag", '"1"').send({ tenantId, data })
  })
  app.get(treasury + "provider-reports", async (req, reply) => {
    const {accountId}=parse(z.strictObject({accountId:z.guid()}),req.query)
    const cfg=await authorizeRequest(req,deps,async ctx=>{
      requirePermission(ctx,readCharges);requirePermission(ctx,"finance.receivables.read")
      return reportMerchant(ctx,accountId)
    })
    return reply.header("cache-control","no-store").send({tenantId:cfg.tenantId,data:await listProviderReports(cfg)})
  })
  async function prepareUpload(req:FastifyRequest,input:{accountId:string;content:string},key:string) {
    const payload={accountId:input.accountId,digest:createHash("sha256").update(input.content).digest("hex")}
    return authorizeRequest(req, deps, async (ctx) => {
      bankRights(ctx)
      const previous = await replay(ctx, key, "finance_collection.import", payload)
      const importId = previous ? String(previous.importId) : randomUUID()
      if (!previous) {
        await ctx.client.query("INSERT INTO finance_collection_imports(tenant_id,id) VALUES($1,$2)", [
          ctx.tenantId,
          importId,
        ])
        await remember(ctx, key, "finance_collection.import", payload, { importId })
      }
      const saved = (
        await ctx.client.query("SELECT result FROM finance_collection_imports WHERE tenant_id=$1 AND id=$2", [
          ctx.tenantId,
          importId,
        ])
      ).rows[0]?.result
      return { tenantId: ctx.tenantId, importId, saved,content:input.content,cfg:null }
    })
  }
  app.post(treasury + "import-return", { bodyLimit: 2_200_000 }, async (req, reply) => {
    const input=parse(z.union([importSchema,z.strictObject({accountId:z.guid(),remoteReportId})]),req.body)
    const key=commandKey(req.headers["idempotency-key"])
    const prepared="remoteReportId" in input ? await prepareProviderImport(req,deps,bankRights,input,key) : await prepareUpload(req,input,key)
    const {tenantId,importId,saved,content}=prepared
    if (saved) return reply.header("etag", '"1"').send(saved)
    const cfg = prepared.cfg ?? requirePilot(tenantId, input.accountId)
    const rows = "remoteReportId" in input && !cfg.live && !content.trim() ? [] : settlementReport(content,cfg.collectorId)
    const outcomes: { id: string; state: string }[] = []
    for (const row of rows) {
      if (row.type !== "settlement" || !z.guid().safeParse(row.externalReference).success) {
        outcomes.push({ id: row.id, state: "outside_scope" })
        continue
      }
      const known = await authorizeRequest(
        req,
        deps,
        async (ctx) => {
          bankRights(ctx)
          return (
            (
              await ctx.client.query(
                "SELECT id FROM finance_collection_charges WHERE tenant_id=$1 AND account_id=$2 AND id=$3",
                [ctx.tenantId, input.accountId, row.externalReference],
              )
            ).rows.length > 0
          )
        },
        false,
      )
      if (!known) {
        outcomes.push({ id: row.id, state: "unknown_charge" })
        continue
      }
      const p = await getPayment(cfg, row.id)
      const centValue = (value: string) => {
        if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) throw invalid("Valor inválido no relatório de liquidação")
        return providerCents(Number(value.replace(",", ".")))
      }
      if (
        row.currency !== "BRL" ||
        p.status !== "approved" ||
        p.external_reference !== row.externalReference ||
        providerCents(p.transaction_amount) !== centValue(row.gross) ||
        p.transaction_details?.net_received_amount == null ||
        providerCents(p.transaction_details.net_received_amount) !== centValue(row.net)
      ) {
        await authorizeRequest(req, deps, async (ctx) => {
          bankRights(ctx)
          await ctx.client.query(`INSERT INTO finance_collection_events(tenant_id,charge_id,source,event_key,outcome)
            VALUES($1,$2,'report_divergence',$3,'divergent') ON CONFLICT DO NOTHING`,
            [ctx.tenantId,row.externalReference,importId + ":" + row.id + ":" + row.externalReference])
        })
        outcomes.push({ id: row.id, state: "divergent" })
        continue
      }
      const result = await authorizeRequest(req, deps, async (ctx) => {
        bankRights(ctx)
        return observePayment(ctx, req.headers, await getCharge(ctx, row.externalReference), p, "report", row.id)
      })
      outcomes.push({ id: row.id, state: result.state })
    }
    const value = { tenantId, data: { outcomes } }
    await authorizeRequest(req, deps, async (ctx) => {
      bankRights(ctx)
      await ctx.client.query(
        "UPDATE finance_collection_imports SET result=$3,csv_content=NULL WHERE tenant_id=$1 AND id=$2 AND result IS NULL",
        [ctx.tenantId, importId, value],
      )
    })
    return reply.header("etag", '"1"').send(value)
  })
  app.post<{ Params: { tenantId: string; accountId: string } }>(
    "/integrations/finance/mercadopago/:tenantId/:accountId",
    async (req, reply) => {
      if (!z.guid().safeParse(req.params.tenantId).success || !z.guid().safeParse(req.params.accountId).success)
        throw missing()
      const cfg = requirePilot(req.params.tenantId, req.params.accountId)
      const query = parse(z.object({ "data.id": z.string().regex(/^\d{1,25}$/) }), req.query)
      const dataId = query["data.id"]
      checkSignature(cfg, req.headers["x-signature"], req.headers["x-request-id"], dataId)
      const event = parse(
        z.object({
          id: z.coerce.string().max(100),
          type: z.literal("payment"),
          live_mode: z.boolean(),
          user_id: z.coerce.string(),
          data: z.object({ id: z.coerce.string() }),
        }),
        req.body,
      )
      if (event.data.id !== dataId || event.live_mode !== cfg.live || event.user_id !== cfg.collectorId)
        throw conflict("Notificação de outra conta ou ambiente")
      const p = await getPayment(cfg, dataId)
      if (!z.guid().safeParse(p.external_reference).success) return reply.send({ ignored: true })
      const data = await withTenantTransaction(
        deps.pool,
        cfg.tenantId,
        cfg.subject,
        async (tenant) => {
          const ctx: AuthorizedContext = {
            ...tenant,
            identity: { subject: cfg.subject, email: "", name: "", emailVerified: false },
          }
          bankRights(ctx)
          const known = await ctx.client.query(
            "SELECT id FROM finance_collection_charges WHERE tenant_id=$1 AND id=$2 AND account_id=$3",
            [ctx.tenantId, p.external_reference, cfg.accountId],
          )
          if (!known.rows.length) return { ignored: true }
          return observePayment(
            ctx,
            req.headers,
            await getCharge(ctx, p.external_reference),
            p,
            "webhook",
            event.id + ":" + p.id + ":" + p.status,
          )
        },
        true,
      )
      return reply.send(data)
    },
  )
}
