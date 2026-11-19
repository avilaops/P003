import type { FastifyReply } from "fastify"
import { z } from "zod"

import { invalid } from "../../platform/domain.js"
import { revisionValue, type Revision } from "../../platform/revision.js"

export const createdAt = "to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
const uuid = z.guid()

/** Identificador inválido na rota nunca existe nesta empresa. */
export const validId = (id: string) => uuid.safeParse(id).success

export function reply(response: FastifyReply, status: number, body: unknown, revision?: Revision) {
  response.code(status).header("cache-control", "no-store")
  if (revision !== undefined) response.header("etag", `"${revision}"`)
  return response.send(body)
}

/** `invalid()` com o título do Rust quando o corpo não passa no esquema estrito. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, title: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw invalid(title)
  return parsed.data
}

export const hasControl = (value: string) => /[\u0000-\u001f\u007f-\u009f]/.test(value)
/** Linha SQL (snake_case) para o contrato JSON (camelCase), com revisão exata. */
export function withRevision(row: Record<string, unknown>) {
  const out: Record<string, unknown> & { revision: Revision } = { revision: revisionValue(row.revision as string | number) }
  for (const [key, value] of Object.entries(row)) out[key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = value
  out.revision = revisionValue(row.revision as string | number)
  return out
}
