import { z } from "zod"

import { Problem } from "../../platform/problem.js"

export const listQuerySchema = z.strictObject({
  q: z.string().max(160).default(""),
  status: z.enum(["active", "archived"]).optional(),
  category_id: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export function parseListQuery(value: unknown) {
  const parsed = listQuerySchema.safeParse(value)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros inválidos")
  return { ...parsed.data, q: parsed.data.q.trim() }
}

export function integer(value: unknown) {
  return typeof value === "number" ? value : Number(value)
}
