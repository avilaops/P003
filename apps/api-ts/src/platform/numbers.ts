import { z } from "zod"
import { revisionValue } from "./revision.js"

export const unsigned32 = z.number().int().min(0).max(4294967295)
export const unsigned64 = z.union([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.bigint().min(0n).max(18446744073709551615n)])
export const signed64 = z.union([z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.bigint().min(-9223372036854775808n).max(9223372036854775807n)]).transform(revisionValue)
