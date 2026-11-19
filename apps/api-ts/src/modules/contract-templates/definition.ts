// Definição editável de um modelo privado. Salvar um rascunho nunca altera uma solicitação de assinatura.
import { z } from "zod"

import { invalid } from "../../platform/domain.js"

export const MAX_FIELDS = 200
const u32 = z.number().int().min(0).max(4294967295)
const area = z.strictObject({ page: u32, x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const field = z.strictObject({
  id: z.guid().transform(value => value.toLowerCase()), name: z.string(), kind: z.string(), role: z.string(), required: z.boolean(),
  page: u32, x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  fontSize: z.number().nullable().optional(), additionalAreas: z.array(area).optional(),
})
export const definitionSchema = z.strictObject({ name: z.string(), pages: u32, roles: z.array(z.string()), fields: z.array(field) })
export type Definition = z.infer<typeof definitionSchema>
export type Area = z.infer<typeof area>

/** Forma persistida: sem `fontSize` vazio e sem `additionalAreas` vazia (como o serde do Rust). */
export function normalized(definition: Definition): Definition {
  return { name: definition.name, pages: definition.pages, roles: definition.roles, fields: definition.fields.map(({ fontSize, additionalAreas, ...rest }) => ({
    ...rest, ...(fontSize === null || fontSize === undefined ? {} : { fontSize }), ...(additionalAreas?.length ? { additionalAreas } : {}),
  })) }
}

const finite = (values: number[]) => values.every(v => Number.isFinite(v) && v >= 0 && v <= 100)
const validArea = (a: Area, pages: number) => a.page > 0 && a.page <= pages && finite([a.x, a.y, a.width, a.height]) && a.width > 0 && a.height > 0 && a.x + a.width <= 100 && a.y + a.height <= 100

export function validateDefinition(definition: Definition) {
  const text = (s: string) => s.trim() !== "" && Buffer.byteLength(s) <= 200 && !/\p{Cc}/u.test(s)
  const roles = new Set<string>(), names = new Set<string>(), ids = new Set<string>()
  if (!text(definition.name) || definition.pages < 1 || definition.pages > 100 || !definition.roles.length || definition.roles.length > 10
    || definition.roles.some(role => !text(role) || roles.has(role) || !roles.add(role)) || definition.fields.length > MAX_FIELDS)
    throw invalid("Nome, páginas ou participantes do modelo inválidos")
  for (const f of definition.fields) {
    const areas = f.additionalAreas ?? []
    if (!text(f.name) || names.has(f.name) || !names.add(f.name) || ids.has(f.id) || !ids.add(f.id) || !roles.has(f.role)
      || !["text", "signature", "initials", "date", "number"].includes(f.kind) || f.page === 0 || f.page > definition.pages
      || !finite([f.x, f.y, f.width, f.height]) || f.width <= 0 || f.height <= 0 || areas.length > 99 || areas.some(a => !validArea(a, definition.pages))
      || (f.fontSize !== null && f.fontSize !== undefined && !(Number.isFinite(f.fontSize) && f.fontSize >= 6 && f.fontSize <= 72))
      || f.x + f.width > 100 || f.y + f.height > 100)
      throw invalid("Confira nomes únicos, participantes e posições dos campos dentro da página")
  }
}
