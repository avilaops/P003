import type { FastifyReply } from "fastify"
import { z } from "zod"

import { invalid } from "../../platform/domain.js"
import { revisionValue, type Revision } from "../../platform/revision.js"

// Permissões do Rust (`logistics.rs`, `logistics_checkout.rs`, `logistics_dispatch.rs`).
export const POSTINGS_READ = "logistics.postings.read"
export const POSTINGS_MANAGE = "logistics.postings.manage"
export const CHECKOUT_READ = "logistics.checkout.read"
export const CHECKOUT_MANAGE = "logistics.checkout.manage"

const uuid = z.guid()
/** Identificador inválido na rota nunca existe nesta empresa (404, como os demais módulos TS). */
export const validId = (id: string) => uuid.safeParse(id).success

/** `bigint` do PostgreSQL chega como texto: devolve número exato (ou `bigint` acima do seguro). */
export const exact = (value: unknown) => revisionValue(value)

export function reply(response: FastifyReply, status: number, body: unknown, revision?: Revision) {
  response.code(status).header("cache-control", "no-store")
  if (revision !== undefined) response.header("etag", `"${revision}"`)
  return response.send(body)
}

/** Corpo estrito: campo desconhecido ou tipo errado vira 422 com o título do Rust. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, title: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw invalid(title)
  return parsed.data
}

export const hasControl = (value: string) => /[\u0000-\u001f\u007f-\u009f]/.test(value)
