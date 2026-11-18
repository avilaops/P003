import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { validateDate } from "../sales/fixed.js"
import { invalid, missing, walletDefinition, wallets } from "./snapshot.js"

export const fileLimit = 14_100_000
const clean = (s: string) => !/[\p{Cc}]/u.test(s)
export const documentSchema = z.strictObject({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .refine((v) => clean(v) && !/[\\/:]/.test(v) && ![".", ".."].includes(v)),
  mediaType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  contentBase64: z.string().min(4).max(13981016),
  description: z.string().trim().min(3).max(2000).refine(clean),
  documentDate: z.string().nullish(),
})
export function prepareDocument(input: z.infer<typeof documentSchema>) {
  const content = Buffer.from(input.contentBase64, "base64")
  if (!content.length || content.length > 10485760 || input.contentBase64 !== content.toString("base64"))
    invalid("Conteúdo base64 inválido ou superior a 10 MiB")
  const formats = {
    "application/pdf": { extension: /\.pdf$/i, signature: Buffer.from("%PDF-") },
    "image/png": { extension: /\.png$/i, signature: Buffer.from("89504e470d0a1a0a", "hex") },
    "image/jpeg": { extension: /\.jpe?g$/i, signature: Buffer.from("ffd8ff", "hex") },
  }
  const format = formats[input.mediaType]
  if (!format.extension.test(input.filename) || !content.subarray(0, format.signature.length).equals(format.signature))
    invalid("Tipo, nome e conteúdo do comprovante devem corresponder")
  const fingerprint = {
    filename: input.filename,
    mediaType: input.mediaType,
    byteSize: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    description: input.description,
    documentDate: input.documentDate == null ? null : validateDate(input.documentDate),
  }
  return { fingerprint, content }
}
export type Headers = FastifyRequest["headers"]
const columns = `id,order_id AS "orderId",payment_id AS "paymentId",filename,media_type AS "mediaType",byte_size::int AS "byteSize",
  sha256,description,document_date::text AS "documentDate",uploaded_at::text AS "uploadedAt",uploaded_by AS "uploadedBy"`
export async function storeDocument(
  ctx: AuthorizedContext,
  headers: Headers,
  orderId: string,
  paymentId: string | null,
  prepared: ReturnType<typeof prepareDocument>,
) {
  let receivableId = null
  if (paymentId) {
    const parent = (
      await ctx.client.query(
        "SELECT p.receivable_id FROM receivable_payments p JOIN receivables r ON (r.tenant_id,r.id)=(p.tenant_id,p.receivable_id) WHERE p.tenant_id=$1 AND p.id=$2 AND p.kind='receipt' AND r.order_id=$3",
        [ctx.tenantId, paymentId, orderId],
      )
    ).rows[0]
    if (!parent) missing()
    receivableId = parent.receivable_id
  }
  const id = randomUUID(),
    d = prepared.fingerprint
  const result = (
    await ctx.client.query(
      `INSERT INTO order_supporting_documents(id,tenant_id,order_id,receivable_id,payment_id,filename,media_type,byte_size,sha256,content,description,document_date,uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${columns}`,
      [
        id,
        ctx.tenantId,
        orderId,
        receivableId,
        paymentId,
        d.filename,
        d.mediaType,
        d.byteSize,
        d.sha256,
        prepared.content,
        d.description,
        d.documentDate,
        ctx.authSubject,
      ],
    )
  ).rows[0]!
  await record(ctx, headers, "supporting_document", id, "order.document_attached", {
    orderId,
    paymentId,
    sha256: d.sha256,
    byteSize: d.byteSize,
  })
  return result
}
function rights(ctx: AuthorizedContext) {
  const sales = ctx.permissions.includes("sales.orders.read"),
    finance = ctx.permissions.includes("finance.receivables.read")
  if (!sales && !finance) requirePermission(ctx, "finance.receivables.read")
  return {
    sales,
    finance,
    canAttachOther: sales && ctx.permissions.includes("sales.orders.manage"),
    canAttachPayment: finance && ctx.permissions.includes("finance.receivables.manage"),
  }
}
export function pathId(value: string) {
  if (!z.guid().safeParse(value).success) invalid("Identificador inválido")
  return value.toLowerCase()
}
async function requireOrder(ctx: AuthorizedContext, id: string) {
  if (
    !(await ctx.client.query("SELECT id FROM sales_orders WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id])).rows
      .length
  )
    missing()
}
export function registerDocumentRoutes(app: FastifyInstance, deps: AppDependencies) {
  for (const wallet of wallets)
    app.get<{ Params: { id: string; paymentId: string } }>(
      "/api/v1/wallet-payment-files/" + wallet + "/:id/:paymentId",
      async (req, reply) => {
        const d = walletDefinition(wallet)
        const proof = await authorizeRequest(req, deps, async (ctx) => {
          requirePermission(ctx, d.permission + ".read")
          const row = (
            await ctx.client.query<{ filename: string; media: string; content: Buffer }>(
              `SELECT p.proof_metadata->>'filename' AS filename,p.proof_metadata->>'mediaType' AS media,p.proof_content AS content
          FROM ${d.payments} p JOIN ${d.titles} r ON (r.tenant_id,r.id)=(p.tenant_id,p.${d.foreign}) WHERE r.tenant_id=$1 AND r.id=$2 AND p.id=$3 AND p.proof_metadata IS NOT NULL ${d.purchaseOnly}`,
              [ctx.tenantId, pathId(req.params.id), pathId(req.params.paymentId)],
            )
          ).rows[0]
          if (!row) missing()
          return row
        })
        const filename = encodeURIComponent(proof.filename).replace(
          /[!'()*]/g,
          (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
        )
        return reply
          .header("cache-control", "private, no-store")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", "attachment; filename*=UTF-8''" + filename)
          .type(proof.media)
          .send(proof.content)
      },
    )
  const url = "/api/v1/orders/:id/documents"
  app.get<{ Params: { id: string } }>(url, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      const right = rights(ctx),
        orderId = pathId(req.params.id)
      await requireOrder(ctx, orderId)
      const data = (
        await ctx.client.query(
          `SELECT ${columns} FROM order_supporting_documents WHERE tenant_id=$1 AND order_id=$2 AND ((payment_id IS NULL AND $3) OR (payment_id IS NOT NULL AND $4)) ORDER BY uploaded_at,id`,
          [ctx.tenantId, orderId, right.sales, right.finance],
        )
      ).rows
      return {
        tenantId: ctx.tenantId,
        orderId,
        canAttachOther: right.canAttachOther,
        canAttachPayment: right.canAttachPayment,
        data,
      }
    })
    return reply.header("cache-control", "private, no-store").send(body)
  })
  app.post<{ Params: { id: string } }>(url, { bodyLimit: fileLimit }, async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"])
    const body = await authorizeRequest(req, deps, async (ctx) => {
      const right = rights(ctx),
        orderId = pathId(req.params.id)
      const parsed = z.strictObject({ paymentId: z.guid().nullish(), document: documentSchema }).safeParse(req.body)
      if (!parsed.success) invalid("Documento inválido")
      const paymentId = parsed.data.paymentId ?? null
      if (!(paymentId ? right.canAttachPayment : right.canAttachOther)) {
        requirePermission(ctx, paymentId ? "finance.receivables.read" : "sales.orders.read")
        requirePermission(ctx, paymentId ? "finance.receivables.manage" : "sales.orders.manage")
      }
      await requireOrder(ctx, orderId)
      const document = prepareDocument(parsed.data.document),
        intent = { orderId, paymentId, document: document.fingerprint }
      const prev = await replay(ctx, key, "order.document.attach", intent)
      if (prev) return prev
      const data = await storeDocument(ctx, req.headers, orderId, paymentId, document),
        result = { tenantId: ctx.tenantId, orderId, data }
      await remember(ctx, key, "order.document.attach", intent, result)
      return result
    })
    return reply
      .code(201)
      .header("etag", `"${(body.data as { sha256: string }).sha256}"`)
      .header("cache-control", "private, no-store")
      .send(body)
  })
  app.get<{ Params: { id: string; documentId: string } }>(url + "/:documentId", async (req, reply) => {
    const item = await authorizeRequest(req, deps, async (ctx) => {
      rights(ctx)
      const row = (
        await ctx.client.query<{ payment_id: string | null; filename: string; media_type: string; content: Buffer }>(
          "SELECT payment_id,filename,media_type,content FROM order_supporting_documents WHERE tenant_id=$1 AND order_id=$2 AND id=$3",
          [ctx.tenantId, pathId(req.params.id), pathId(req.params.documentId)],
        )
      ).rows[0]
      if (!row) missing()
      requirePermission(ctx, row.payment_id ? "finance.receivables.read" : "sales.orders.read")
      return row
    })
    const filename = encodeURIComponent(item.filename).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    )
    return reply
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment; filename*=UTF-8''" + filename)
      .type(item.media_type)
      .send(item.content)
  })
}
