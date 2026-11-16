import { isDeepStrictEqual } from "node:util"

// PostgreSQL JSONB reorders object keys. Compare JSON values, not insertion order;
// serialization also removes undefined properties in normalized command inputs.
export function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)))
}
