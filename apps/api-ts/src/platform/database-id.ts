import { z } from "zod"

// PostgreSQL UUIDs have a canonical hex layout regardless of version or variant.
export const databaseId = z.guid()
export const normalizedDatabaseId = databaseId.transform(value => value.toLowerCase())
