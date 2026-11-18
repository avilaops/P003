import { createHash, randomUUID } from "node:crypto"
import type { FastifyRequest } from "fastify"
import { z } from "zod"
import { authorizeRequest, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { record, remember, replay } from "../../platform/commands.js"
import { parseJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { account, conflict, invalid } from "./ledger.js"
import { requirePilot, settlementReport, verifyMerchant, type Merchant } from "./mercadopago.js"

const reportUrl = "https://api.mercadopago.com/v1/account/settlement_report/"
export const remoteReportId = z.string().regex(/^\d{1,25}$/)
const reportRow = z.object({
  id: z.coerce.string().pipe(remoteReportId),
  user_id: z.coerce.string(),
  file_name: z.string().nullable().optional(),
  begin_date: z.string().optional(),
  end_date: z.string().optional(),
})
const csvName = (name: string) =>
  name.length <= 220 && /^[\p{L}\p{N}][\p{L}\p{N} ._-]*\.csv$/iu.test(name) && !name.includes("..")
async function readFile(config: Merchant, path: string, list: boolean, transport: typeof fetch) {
  const response = await transport(reportUrl + path, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: {
      Authorization: "Bearer " + config.accessToken,
      Accept: list ? "application/json" : "text/csv,application/octet-stream,text/plain",
    },
  }).catch(() => {
    throw new Problem(503, "bank_unavailable", "Mercado Pago indisponível para consultar o relatório")
  })
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel()
    throw new Problem(
      response.status >= 500 || response.status === 429 ? 503 : 422,
      "bank_report_unavailable",
      "Relatório indisponível no Mercado Pago",
    )
  }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  const limit = list ? 4_000_000 : 2_000_000
  if (
    (!list &&
      type &&
      !["text/csv", "text/plain", "application/csv", "application/octet-stream", "application/vnd.ms-excel"].includes(
        type,
      )) ||
    Number(response.headers.get("content-length")) > limit
  ) {
    await response.body.cancel()
    throw invalid("Tipo ou tamanho do retorno bancário inválido")
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw invalid("O retorno bancário excede o tamanho permitido")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } catch {
    throw invalid("O arquivo do banco precisa usar UTF-8")
  }
}
export async function listProviderReports(config: Merchant, transport: typeof fetch = fetch) {
  await verifyMerchant(config, transport)
  const raw = await readFile(config, "list", true, transport)
  let json: unknown
  try {
    json = parseJson(raw.replace(/^\uFEFF/, ""))
  } catch {
    throw invalid("Lista de relatórios inválida no provedor")
  }
  const parsed = z.array(reportRow).safeParse(json)
  if (!parsed.success || parsed.data.some((r) => r.user_id !== config.collectorId))
    throw conflict("A lista de relatórios diverge do vendedor da conta")
  const ids = new Set<string>(),
    names = new Set<string>()
  return parsed.data.flatMap((r) => {
    if (!r.file_name || !csvName(r.file_name)) return []
    if (ids.has(r.id) || names.has(r.file_name)) throw conflict("O provedor retornou identificação ambígua de arquivo")
    ids.add(r.id)
    names.add(r.file_name)
    return [{ id: r.id, name: r.file_name, from: r.begin_date ?? null, to: r.end_date ?? null }]
  })
}
export async function downloadProviderReport(config: Merchant, id: string, transport: typeof fetch = fetch) {
  const report = (await listProviderReports(config, transport)).find((r) => r.id === id)
  if (!report) throw invalid("Selecione um arquivo CSV disponível para esta conta")
  const content = await readFile(config, encodeURIComponent(report.name), false, transport)
  return { name: report.name, content, digest: createHash("sha256").update(content).digest("hex") }
}

export async function reportMerchant(ctx: AuthorizedContext, accountId: string) {
  const bank = await account(ctx, accountId)
  if (bank.status !== "active" || bank.accountType !== "bank") throw conflict("Selecione uma conta bancária ativa")
  return requirePilot(ctx.tenantId, accountId)
}
type SavedReport = { id: string; result: unknown; csv_content: string | null; collector_id: string; live_mode: boolean }
export async function prepareProviderImport(
  req: FastifyRequest,
  deps: AccessDependencies,
  rights: (ctx: AuthorizedContext) => void,
  input: { accountId: string; remoteReportId: string },
  key: string,
) {
  const scope = "finance_collection.import_remote"
  const select =
    "SELECT id,result,csv_content,collector_id,live_mode FROM finance_collection_imports WHERE tenant_id=$1 AND account_id=$2 AND collector_id=$3 AND live_mode=$4 AND report_id=$5"
  const status = await authorizeRequest(
    req,
    deps,
    async (ctx) => {
      rights(ctx)
      const cfg = await reportMerchant(ctx, input.accountId)
      const args = [ctx.tenantId, input.accountId, cfg.collectorId, cfg.live, input.remoteReportId]
      const previous = await replay(ctx, key, scope, input)
      const existing = (await ctx.client.query<SavedReport>(select, args)).rows[0]
      if (previous && previous.importId !== existing?.id)
        throw conflict("O vínculo bancário mudou desde a confirmação da importação")
      return { cfg, existing }
    },
    false,
  )
  const downloaded = status.existing ? null : await downloadProviderReport(status.cfg, input.remoteReportId)
  if (downloaded && (downloaded.content.trim() || status.cfg.live))
    settlementReport(downloaded.content, status.cfg.collectorId)
  return authorizeRequest(req, deps, async (ctx) => {
    rights(ctx)
    const cfg = await reportMerchant(ctx, input.accountId)
    if (
      cfg.tenantId !== status.cfg.tenantId ||
      cfg.collectorId !== status.cfg.collectorId ||
      cfg.live !== status.cfg.live
    )
      throw conflict("O vínculo bancário mudou. Confira a conta novamente")
    const args = [ctx.tenantId, input.accountId, cfg.collectorId, cfg.live, input.remoteReportId]
    const prior = await replay(ctx, key, scope, input)
    let row = (await ctx.client.query<SavedReport>(select, args)).rows[0]
    if (!row && downloaded) {
      const id = randomUUID()
      await ctx.client.query(
        `INSERT INTO finance_collection_imports(tenant_id,account_id,collector_id,live_mode,report_id,id,file_name,content_sha256,csv_content)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [...args, id, downloaded.name, downloaded.digest, downloaded.content],
      )
      row = { id, result: null, csv_content: downloaded.content, collector_id: cfg.collectorId, live_mode: cfg.live }
      await record(ctx, req.headers, "finance_collection", id, "finance_collection.report_downloaded", {
        accountId: input.accountId,
        reportId: input.remoteReportId,
        file: downloaded.name,
        sha256: downloaded.digest,
      })
    }
    if (!row || (prior && prior.importId !== row.id))
      throw conflict("O relatório preparado diverge da confirmação anterior")
    if (!prior) await remember(ctx, key, scope, input, { importId: row.id })
    return { tenantId: ctx.tenantId, importId: row.id, saved: row.result, content: row.csv_content ?? "", cfg }
  })
}
