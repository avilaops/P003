import { Problem } from "./problem.js"

export type Revision = number | bigint
const maximum = 9223372036854775807n

export function revisionValue(value: unknown): Revision {
  const exact = BigInt(String(value))
  return exact <= BigInt(Number.MAX_SAFE_INTEGER) && exact >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(exact) : exact
}

export function parseRevision(value: string | string[] | undefined): Revision {
  if (value === undefined) throw new Problem(428, "revision_required", "Recarregue o cadastro antes de salvar")
  const match = typeof value === "string" ? /^"([0-9]+)"$/.exec(value) : null
  if (!match?.[1]) throw new Problem(400, "invalid_revision", "Revisão inválida")
  const exact = BigInt(match[1])
  if (exact <= 0n || exact > maximum) throw new Problem(400, "invalid_revision", "Revisão inválida")
  return revisionValue(exact)
}

export function nextRevision(value: Revision): Revision {
  const next = BigInt(value) + 1n
  if (next > maximum) throw new Problem(500, "internal_error", "Erro interno")
  return revisionValue(next)
}
