// Detecção de prováveis duplicados: funções puras, sem banco, para testar sem fixture.
export type Candidate = { id: string; name: string; email?: string | null; phone?: string | null }
export type DuplicatePair = { a: string; b: string; reasons: ("same_email" | "same_phone" | "similar_name")[]; score: number }

export const normalizeName = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "")
const digits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "")

function distance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = row
  }
  return previous[b.length]!
}
/** 1 = idêntico; nomes normalizados (sem acento, caixa ou pontuação). */
export function nameSimilarity(left: string, right: string) {
  const a = normalizeName(left), b = normalizeName(right), size = Math.max(a.length, b.length)
  if (size === 0) return 0
  const limit = Math.ceil(size * 0.2)
  const gap = distance(a, b, limit)
  return gap > limit ? 0 : 1 - gap / size
}

export const NAME_THRESHOLD = 0.85
/** Compara dentro de blocos pelo início do nome normalizado e por e-mail/telefone idênticos. */
export function findDuplicates(items: readonly Candidate[], threshold = NAME_THRESHOLD): DuplicatePair[] {
  const pairs = new Map<string, DuplicatePair>()
  const add = (x: Candidate, y: Candidate, reason: DuplicatePair["reasons"][number], score: number) => {
    const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id], key = a + "|" + b
    const found = pairs.get(key)
    if (found) { if (!found.reasons.includes(reason)) found.reasons.push(reason); found.score = Math.max(found.score, score) } else pairs.set(key, { a, b, reasons: [reason], score })
  }
  const index = (pick: (item: Candidate) => string, reason: "same_email" | "same_phone", minimum: number) => {
    const groups = new Map<string, Candidate[]>()
    for (const item of items) { const key = pick(item); if (key.length >= minimum) groups.set(key, [...(groups.get(key) ?? []), item]) }
    for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) add(group[i]!, group[j]!, reason, 1)
  }
  index(item => (item.email ?? "").trim().toLowerCase(), "same_email", 3)
  index(item => digits(item.phone), "same_phone", 8)
  const blocks = new Map<string, { item: Candidate; name: string }[]>()
  for (const item of items) {
    const name = normalizeName(item.name)
    if (name.length < 6) continue
    const key = name.slice(0, 3)
    blocks.set(key, [...(blocks.get(key) ?? []), { item, name }])
  }
  for (const block of blocks.values()) for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
    const score = nameSimilarity(block[i]!.name, block[j]!.name)
    if (score >= threshold) add(block[i]!.item, block[j]!.item, "similar_name", Math.round(score * 100) / 100)
  }
  return [...pairs.values()].sort((x, y) => y.score - x.score || x.a.localeCompare(y.a))
}
