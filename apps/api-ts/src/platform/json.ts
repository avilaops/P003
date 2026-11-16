import { isDeepStrictEqual } from "node:util"

// Node >=22 supports rawJSON and the reviver source token. Keep numeric JSON
// tokens on the wire, matching serde_json i64, while using bigint internally.
const exactJson = JSON as unknown as {
  rawJSON(value: string): unknown
  parse(value: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): any
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? exactJson.rawJSON(item.toString()) : item)
}

export function parseJson(value: string): any {
  return exactJson.parse(value, (_key, item, context) => typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item) && context.source && /^-?\d+$/.test(context.source) ? BigInt(context.source) : item)
}

// PostgreSQL JSONB reorders object keys. Compare JSON values, not insertion order;
// serialization also removes undefined properties in normalized command inputs.
export function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(parseJson(stringifyJson(left)), parseJson(stringifyJson(right)))
}
