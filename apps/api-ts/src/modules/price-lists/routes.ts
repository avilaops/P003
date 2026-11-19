import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { integer, queryInteger, searchQuery } from "../registrations/query.js"

const invalid = (title: string) => new Problem(422, "invalid_input", title)
const upper = (value: string) => value.replace(/[a-z]/g, character => character.toUpperCase())
const isoDate = z.string().refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1900-01-01" && value <= "2100-12-31" && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value))
const optionalText = <T extends z.ZodType>(schema: T) => z.preprocess(value => value ?? null, schema.nullable())

export const priceListInputSchema = z.strictObject({
  code: z.string().trim().transform(upper).pipe(z.string().regex(/^[A-Z0-9._-]{1,40}$/)),
  name: z.string().trim().refine(value => value.length > 0 && [...value].length <= 200 && !/\p{Cc}/u.test(value)),
  status: z.enum(["active", "archived"]),
  validFrom: optionalText(isoDate),
  validUntil: optionalText(isoDate),
  notes: z.preprocess(value => typeof value === "string" ? value.trim() || null : value ?? null, z.string().refine(value => [...value].length <= 1000 && !/\p{Cc}/u.test(value)).nullable()),
  items: z.array(z.strictObject({ productId: databaseId.transform(value => value.toLowerCase()), price: z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/) })).min(1).max(1000),
}).superRefine((value, context) => {
  if (value.validFrom && value.validUntil && value.validFrom > value.validUntil) context.addIssue({ code: "custom", message: "Fim da vigência deve ser igual ou posterior ao início" })
  if (new Set(value.items.map(item => item.productId)).size !== value.items.length) context.addIssue({ code: "custom", message: "Produto repetido na tabela" })
})
type PriceListInput = z.infer<typeof priceListInputSchema>
type Snapshot = { tenantId: string; canEdit: boolean; data: Awaited<ReturnType<typeof load>> }

const listQuerySchema = z.strictObject({
  q: searchQuery, status: z.enum(["active", "archived"]).optional(),
  offset: queryInteger(0, 100_000).default(0), limit: queryInteger(1, 100).default(25),
})

function price(cents: unknown) {
  const value = BigInt(String(cents))
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`
}
const cents = (value: string) => BigInt(value.replace(".", ""))

async function load(context: AuthorizedContext, id: string) {
  const found = await context.client.query("SELECT id,revision,code,name,status,valid_from::text,valid_until::text,notes FROM price_lists WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])
  const row = found.rows[0]
  if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  const items = await context.client.query("SELECT i.product_id,p.name,p.sku,p.unit,i.price_cents FROM price_list_items i JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id WHERE i.tenant_id=$1 AND i.price_list_id=$2 ORDER BY p.name,p.id", [context.tenantId, id])
  return {
    id: row.id, revision: revisionValue(row.revision), code: row.code, name: row.name, status: row.status,
    validFrom: row.valid_from, validUntil: row.valid_until, notes: row.notes,
    items: items.rows.map(item => ({ productId: item.product_id, name: item.name, sku: item.sku, unit: item.unit, price: price(item.price_cents) })),
  }
}

async function validateProducts(context: AuthorizedContext, id: string | null, input: PriceListInput) {
  const ids = input.items.map(item => item.productId)
  const count = await context.client.query<{ total: string }>("SELECT count(*)::text AS total FROM products p WHERE p.tenant_id=$1 AND p.id=ANY($2::uuid[]) AND (p.status='active' OR EXISTS(SELECT 1 FROM price_list_items i WHERE i.tenant_id=p.tenant_id AND i.product_id=p.id AND i.price_list_id=$3))", [context.tenantId, ids, id])
  if (Number(count.rows[0]?.total) !== ids.length) throw invalid("Produtos devem pertencer à empresa e estar ativos ao serem incluídos")
}

async function saveItems(context: AuthorizedContext, id: string, input: PriceListInput) {
  await context.client.query("DELETE FROM price_list_items WHERE tenant_id=$1 AND price_list_id=$2", [context.tenantId, id])
  await context.client.query("INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price_cents) SELECT $1,$2,product_id,price FROM unnest($3::uuid[],$4::bigint[]) AS item(product_id,price)",
    [context.tenantId, id, input.items.map(item => item.productId), input.items.map(item => cents(item.price).toString())])
}

function duplicateCode(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new Problem(409, "domain_conflict", "Código já cadastrado nesta empresa, inclusive em tabela arquivada")
  throw error
}

export function registerPriceListRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/price-lists", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) throw invalid("Busca, paginação ou situação inválida")
    const query = parsed.data
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const filter = (alias: string) => `${alias}tenant_id=$1 AND ($2::text IS NULL OR ${alias}status=$2) AND (strpos(lower(${alias}name),lower($3))>0 OR strpos(${alias}code,upper($3))>0)`
      const rows = await context.client.query(`SELECT l.id,l.revision,l.code,l.name,l.status,l.valid_from::text,l.valid_until::text,(SELECT count(*) FROM price_list_items i WHERE i.tenant_id=l.tenant_id AND i.price_list_id=l.id)::int AS item_count FROM price_lists l WHERE ${filter("l.")} ORDER BY l.name,l.id LIMIT $4 OFFSET $5`, [context.tenantId, query.status ?? null, query.q, query.limit, query.offset])
      const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM price_lists WHERE ${filter("")}`, [context.tenantId, query.status ?? null, query.q])
      return {
        tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.products.manage"),
        data: rows.rows.map(row => ({ id: row.id, revision: revisionValue(row.revision), code: row.code, name: row.name, status: row.status, validFrom: row.valid_from, validUntil: row.valid_until, itemCount: row.item_count })),
        total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit,
      }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/price-lists/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      if (!databaseId.safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.products.manage"), data: await load(context, request.params.id) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.post("/api/v1/price-lists", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      requirePermission(context, "catalog.products.manage")
      const parsed = priceListInputSchema.safeParse(request.body)
      if (!parsed.success) throw invalid("Tabela de preços inválida ou campos desconhecidos")
      const input = parsed.data, saved = { id: null, revision: null, input }
      const previous = await replay(context, key, "price_lists.create", saved)
      if (previous) return previous as unknown as Snapshot
      await validateProducts(context, null, input)
      const id = randomUUID()
      await context.client.query("INSERT INTO price_lists(tenant_id,id,code,name,status,valid_from,valid_until,notes) VALUES($1,$2,$3,$4,$5,$6::text::date,$7::text::date,$8)", [context.tenantId, id, input.code, input.name, input.status, input.validFrom, input.validUntil, input.notes]).catch(duplicateCode)
      await saveItems(context, id, input)
      const result: Snapshot = { tenantId: context.tenantId, canEdit: true, data: await load(context, id) }
      await record(context, request.headers, "price_list", id, "price_list.created", { revision: 1, itemCount: input.items.length })
      await remember(context, key, "price_lists.create", saved, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/price-lists/:id", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      requirePermission(context, "catalog.products.manage")
      const parsed = priceListInputSchema.safeParse(request.body)
      if (!parsed.success) throw invalid("Tabela de preços inválida ou campos desconhecidos")
      if (!databaseId.safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      const id = request.params.id.toLowerCase(), input = parsed.data
      const saved = { id, revision: String(expected), input }
      const previousResult = await replay(context, key, "price_lists.update", saved)
      if (previousResult) return previousResult as unknown as Snapshot
      const previous = await load(context, id)
      if (previous.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      await validateProducts(context, id, input)
      const next = nextRevision(expected)
      await context.client.query("UPDATE price_lists SET code=$3,name=$4,status=$5,valid_from=$6::text::date,valid_until=$7::text::date,notes=$8,revision=$9,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, input.code, input.name, input.status, input.validFrom, input.validUntil, input.notes, next]).catch(duplicateCode)
      await saveItems(context, id, input)
      const result: Snapshot = { tenantId: context.tenantId, canEdit: true, data: await load(context, id) }
      await record(context, request.headers, "price_list", id, "price_list.updated", { previousRevision: expected, revision: next, itemCount: input.items.length })
      await remember(context, key, "price_lists.update", saved, result)
      return result
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
}
