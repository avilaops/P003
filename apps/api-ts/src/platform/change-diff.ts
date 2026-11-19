// Antes/depois de um cadastro para o histórico (audit_log.details.changes). Só os campos que mudaram; blobs e textos longos são resumidos.
export type FieldChange = { before: unknown; after: unknown }
const summarize = (key: string, value: unknown): unknown => {
  if (/DataUrl$/i.test(key)) return value ? "[imagem]" : null
  if (typeof value === "string" && value.length > 200) return value.slice(0, 200) + "…"
  if (value !== null && typeof value === "object" && JSON.stringify(value).length > 2000) return "[conteúdo extenso]"
  return value === undefined ? null : value
}
export function diffChanges(before: Record<string, unknown>, after: Record<string, unknown>, ignore: readonly string[] = ["id", "revision", "tenantId"]) {
  const changes: Record<string, FieldChange> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignore.includes(key) || JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null)) continue
    changes[key] = { before: summarize(key, before[key]), after: summarize(key, after[key]) }
  }
  return changes
}
