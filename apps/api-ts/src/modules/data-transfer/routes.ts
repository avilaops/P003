import { createHash, randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { productInputSchema } from "../products/schema.js"
import { csvCell, MAX_BYTES, parseCsv } from "./csv.js"

const IMPORT = "catalog.products.import"
const EXPORT = "catalog.products.export"
const bodySchema = z.strictObject({ filename: z.string(), content: z.string() })
const exportQuery = z.object({ q: z.string().optional(), status: z.string().optional() })
const allowed = ["sku", "codigo", "name", "nome", "unit", "unidade", "base_price", "preco", "price", "ncm", "cest", "status"]
const fieldLabels: Record<string, string> = { sku: "SKU", name: "nome", unit: "unidade", basePrice: "preço", ncm: "NCM", cest: "CEST", status: "situação" }

type ProductRow = ReturnType<typeof productInputSchema.parse>
type ImportRow = { line: number; input: Record<string, unknown>; error: string | null; conflict: boolean }

// 422 carrying every invalid line so the file can be fixed in one pass.
class ImportProblem extends Problem {
  constructor(readonly errors: { line: number; message: string }[]) { super(422, "invalid_import", "O CSV contém linhas inválidas. Corrija e envie novamente") }
  override toJSON() { return { ...super.toJSON(), errors: this.errors } }
}
const invalid = (title: string) => new Problem(422, "invalid_input", title)

function cell(headers: string[], row: string[], names: string[]) {
  for (const name of names) { const index = headers.indexOf(name); if (index >= 0) return (row[index] ?? "").trim() }
  return ""
}

async function findJob(context: AuthorizedContext, id: string, lock = false) {
  const found = await context.client.query(`SELECT id,source_name,status,rows,result FROM product_import_jobs WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [context.tenantId, id])
  const job = found.rows[0]
  if (!job) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  const rows = job.rows as ImportRow[]
  return {
    id: job.id, filename: job.source_name, format: "csv", status: job.status, rows,
    valid: rows.filter(row => row.error === null && !row.conflict).length,
    invalid: rows.filter(row => row.error !== null).length,
    conflicts: rows.filter(row => row.conflict).length, result: job.result,
  }
}

function rowMessage(error: z.ZodError) {
  const fields = [...new Set(error.issues.map(issue => fieldLabels[String(issue.path[0])] ?? "linha"))]
  return `Linha inválida: confira ${fields.join(", ")}`
}

export function registerDataTransferRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  // 2 MiB of CSV can double when JSON-escaped; the byte limit is enforced on the decoded content.
  app.post("/api/v1/products/import", { bodyLimit: 4_500_000 }, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, IMPORT)
      const parsed = bodySchema.safeParse(request.body)
      if (!parsed.success) throw invalid("JSON inválido ou campos desconhecidos")
      const { filename, content } = parsed.data
      if (filename.length > 160 || !filename.toLowerCase().endsWith(".csv")) throw invalid("Selecione um arquivo CSV")
      if (Buffer.byteLength(content) > MAX_BYTES) throw invalid("Arquivo CSV acima do limite de 2 MiB")
      const digest = createHash("sha256").update(content).digest("hex")
      const existing = await context.client.query<{ id: string }>("SELECT id FROM product_import_jobs WHERE tenant_id=$1 AND source_sha256=$2", [context.tenantId, digest])
      if (existing.rows[0]) return { status: 200, body: { data: await findJob(context, existing.rows[0].id) } }
      let table: string[][]
      try { table = parseCsv(content) } catch (error) { throw invalid((error as Error).message) }
      if (table.length < 2) throw invalid("O CSV não contém registros de produtos")
      const headers = table[0]!.map(value => value.trim().toLowerCase())
      if (!headers.some(value => ["sku", "codigo"].includes(value)) || !headers.some(value => ["name", "nome"].includes(value))) throw invalid("O CSV precisa conter as colunas SKU e nome")
      if (headers.some(value => !allowed.includes(value))) throw invalid("O CSV contém uma coluna desconhecida")
      if (new Set(headers).size !== headers.length) throw invalid("O CSV não pode repetir colunas")
      const raw = table.slice(1)
      const skus = raw.map(row => cell(headers, row, ["sku", "codigo"]).toUpperCase())
      const existingSkus = new Set((await context.client.query<{ sku: string }>("SELECT sku FROM products WHERE tenant_id=$1 AND sku=ANY($2::text[])", [context.tenantId, skus])).rows.map(row => row.sku))
      const settings = (await context.client.query<{ data: { requireNcm?: boolean; requireCest?: boolean } }>("SELECT data FROM registration_settings WHERE tenant_id=$1 AND section='products'", [context.tenantId])).rows[0]?.data ?? {}
      const rows: ImportRow[] = []
      const errors: { line: number; message: string }[] = []
      const seen = new Set<string>()
      raw.forEach((values, index) => {
        const line = index + 2
        const candidate: Record<string, unknown> = {
          sku: cell(headers, values, ["sku", "codigo"]), name: cell(headers, values, ["name", "nome"]), unit: cell(headers, values, ["unit", "unidade"]),
          basePrice: cell(headers, values, ["base_price", "preco", "price"]), status: cell(headers, values, ["status"]) || "active",
          structureColors: [], upholsteryColors: [], plateHolderColors: [], plateHolderTypes: [],
        }
        for (const field of ["ncm", "cest"]) { const value = cell(headers, values, [field]); if (value) candidate[field] = value }
        const result = productInputSchema.safeParse(candidate)
        let message: string | null = null
        if (!result.success) message = rowMessage(result.error)
        else if (settings.requireNcm && !result.data.ncm) message = "Linha inválida: NCM obrigatório"
        else if (settings.requireCest && !result.data.cest) message = "Linha inválida: CEST obrigatório"
        if (message) errors.push({ line, message })
        const input = result.success ? result.data as ProductRow : candidate
        const sku = result.success ? result.data.sku : ""
        const conflict = message === null && (existingSkus.has(sku) || seen.has(sku))
        if (sku) seen.add(sku)
        rows.push({ line, input: { ...input }, error: message, conflict })
      })
      if (errors.length > 0) throw new ImportProblem(errors)
      const id = randomUUID()
      await context.client.query("INSERT INTO product_import_jobs(id,tenant_id,source_sha256,source_name,format,status,rows,created_by_identity_id) SELECT $1,$2,$3,$4,'csv','previewed',$5,id FROM identities WHERE auth_subject=$6", [id, context.tenantId, digest, filename, JSON.stringify(rows), context.identity.subject])
      return { status: 201, body: { data: await findJob(context, id) } }
    })
    return reply.code(body.status).header("cache-control", "no-store").send(body.body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/products/import/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, IMPORT)
      if (!databaseId.safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      return { data: await findJob(context, request.params.id.toLowerCase()) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post<{ Params: { id: string } }>("/api/v1/products/import/:id/confirm", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, IMPORT)
      const key = commandKey(request.headers["idempotency-key"])
      if (!databaseId.safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      const id = request.params.id.toLowerCase()
      const job = await findJob(context, id, true)
      // The key belongs to this job: repeating it returns the result; reusing it on another job is a conflict.
      if (await replay(context, key, "products.import.confirm", { job: id })) return { data: job }
      // A confirmed job is final: a new key on the same job returns the same result without importing again.
      if (job.status === "imported") { await remember(context, key, "products.import.confirm", { job: id }, { job: id }); return { data: job } }
      let imported = 0
      for (const row of job.rows.filter(item => item.error === null && !item.conflict)) {
        const parsed = productInputSchema.safeParse(row.input)
        if (!parsed.success) throw invalid("A prévia não é mais válida")
        const item = parsed.data
        const cents = BigInt(item.basePrice.replace(".", "")).toString()
        await context.client.query("INSERT INTO products(id,tenant_id,sku,name,unit,ncm,cest,price_cents,status,structure_colors,upholstery_colors,plate_holder_colors,plate_holder_types,plate_holder_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}','{}','{}','{}','')", [randomUUID(), context.tenantId, item.sku, item.name, item.unit, item.ncm, item.cest, cents, item.status])
          .catch(error => { throw (error as { code?: string }).code === "23505" ? new Problem(409, "domain_conflict", "SKU já cadastrado nesta empresa") : error })
        imported++
      }
      const result = { imported, total: job.rows.length }
      await context.client.query("UPDATE product_import_jobs SET status='imported',result=$3,completed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, JSON.stringify(result)])
      await record(context, request.headers, "product_import", id, "products.imported", result)
      await remember(context, key, "products.import.confirm", { job: id }, { job: id })
      return { data: await findJob(context, id) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get("/api/v1/products/export", async (request, reply) => {
    const query = exportQuery.safeParse(request.query)
    const csv = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, EXPORT)
      if (!query.success || (query.data.q ?? "").length > 160 || (query.data.status !== undefined && !["active", "archived"].includes(query.data.status))) throw invalid("Filtro de exportação inválido")
      const search = query.data.q?.trim() || null
      const rows = await context.client.query("SELECT sku,name,unit,ncm,cest,price_cents,status FROM products WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR strpos(lower(name),lower($3))>0 OR strpos(lower(sku),lower($3))>0) ORDER BY name,sku", [context.tenantId, query.data.status ?? null, search])
      const lines = ["sku,name,unit,ncm,cest,base_price,status"]
      for (const row of rows.rows) {
        const cents = BigInt(String(row.price_cents))
        const fields = [row.sku, row.name, row.unit, row.ncm ?? "", row.cest ?? "", `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`, row.status]
        lines.push(fields.map(field => csvCell(String(field))).join(","))
      }
      return `${lines.join("\r\n")}\r\n`
    })
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", "attachment; filename=produtos.csv").header("cache-control", "no-store").send(csv)
  })
}
