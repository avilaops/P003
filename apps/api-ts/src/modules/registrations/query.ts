import { z } from "zod"

import { Problem } from "../../platform/problem.js"

export const searchQuery = z.string().transform(value => value.trim()).refine(value => Array.from(value).length <= 160).default("")
export function queryInteger(minimum: number, maximum: number) {
  return z.string().regex(/^\+?[0-9]+$/).transform(Number).pipe(z.number().int().min(minimum).max(maximum))
}

export const listQuerySchema = z.strictObject({
  q: searchQuery,
  status: z.enum(["active", "archived"]).optional(),
  category_id: z.string().uuid().optional(),
  offset: queryInteger(0, 100_000).default(0),
  limit: queryInteger(1, 100).default(25),
})

export function parseListQuery(value: unknown) {
  const parsed = listQuerySchema.safeParse(value)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros inválidos")
  return { ...parsed.data, q: parsed.data.q.trim() }
}

export function integer(value: unknown) {
  return typeof value === "number" ? value : Number(value)
}
