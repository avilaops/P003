// Converte um modelo do portal em definição editável. Semântica não suportada é rejeitada,
// nunca apagada em silêncio: o original continua preservado no portal.
import { z } from "zod"

import { invalid } from "../../platform/domain.js"
import { validateDefinition, type Area, type Definition } from "./definition.js"

type Json = any
const unsupported = () => invalid("Este modelo usa documentos ou campos ainda não suportados pelo editor. O original foi preservado")
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const uuid = z.guid()

export function definitionFromTemplate(template: Json): Definition {
  const documents = template?.documents, schema = template?.schema
  if (!Array.isArray(documents) || !Array.isArray(schema) || documents.length !== 1 || schema.length !== 1 || schema[0]?.dynamic === true) throw unsupported()
  const attachment = documents[0]?.uuid
  if (typeof attachment !== "string") throw unsupported()
  const submitters = template?.submitters
  if (!Array.isArray(submitters)) throw unsupported()
  const roles = submitters.map((s: Json) => { if (typeof s?.name !== "string") throw unsupported(); return s.name as string })
  if (!Array.isArray(template?.fields)) throw unsupported()
  let pages = 1
  const pageOf = (area: Json) => {
    const page = area?.page
    if (!Number.isInteger(page) || page < 0 || page >= 100) throw unsupported()
    pages = Math.max(pages, page + 1)
    return page + 1
  }
  const position = (area: Json, key: string) => {
    const value = area?.[key]
    if (typeof value !== "number" || !Number.isFinite(value)) throw unsupported()
    return Math.round(value * 10000) / 100
  }
  const fields = template.fields.map((field: Json) => {
    if (field?.readonly === true || (field?.default_value !== null && field?.default_value !== undefined)
      || ["conditions", "options"].some(key => Array.isArray(field?.[key]) && field[key].length)
      || (isObject(field?.validation) && Object.keys(field.validation).length)
      || (isObject(field?.preferences) && Object.keys(field.preferences).some(key => key !== "font_size"))) throw unsupported()
    const areas = field?.areas
    if (!Array.isArray(areas) || !areas.length || areas.length > 100 || areas.some((a: Json) => a?.attachment_uuid !== attachment)) throw unsupported()
    const first = areas[0]
    const page = pageOf(first)
    const additionalAreas: Area[] = areas.slice(1).map((a: Json) => ({ page: pageOf(a), x: position(a, "x"), y: position(a, "y"), width: position(a, "w"), height: position(a, "h") }))
    const role = submitters.find((s: Json) => s?.uuid === field?.submitter_uuid)?.name
    if (typeof role !== "string") throw unsupported()
    const id = uuid.safeParse(field?.uuid)
    if (!id.success || typeof field?.name !== "string" || typeof field?.type !== "string") throw unsupported()
    const raw = field?.preferences?.font_size
    let fontSize: number | undefined
    if (raw !== null && raw !== undefined) {
      if (typeof raw === "number") fontSize = raw
      else if (typeof raw === "string" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) fontSize = Number(raw)
      else throw unsupported()
    }
    return { id: id.data.toLowerCase(), name: field.name, kind: field.type, role, required: field?.required === true, page,
      x: position(first, "x"), y: position(first, "y"), width: position(first, "w"), height: position(first, "h"),
      ...(fontSize === undefined ? {} : { fontSize }), ...(additionalAreas.length ? { additionalAreas } : {}) }
  })
  if (typeof template?.name !== "string") throw unsupported()
  const result: Definition = { name: template.name, pages, roles, fields }
  validateDefinition(result)
  return result
}
