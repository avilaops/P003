import { fileURLToPath } from "node:url"
import { Pool } from "pg"

import { MigrationError, runMigrations } from "./platform/migrations.js"

const usage = `npm run migrate -- [directory]
Build first with npm run build.
Set DATABASE_URL to the PostgreSQL connection URL.
The default directory is migrations/ at the repository root.`

async function main() {
  const [directory, ...extraArgs] = process.argv.slice(2)
  if (directory === "--help" && extraArgs.length === 0) {
    console.log(usage)
    return
  }
  if (extraArgs.length || directory?.startsWith("--")) throw new MigrationError(usage)

  const connectionString = process.env.DATABASE_URL
  if (!connectionString?.trim()) throw new MigrationError("DATABASE_URL is required")

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const result = await runMigrations(pool, {
      directory: directory ?? fileURLToPath(new URL("../../../migrations/", import.meta.url)),
    })
    console.log(JSON.stringify(result))
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof MigrationError ? error.message : "Migration failed • check the PostgreSQL connection and migration directory")
  process.exitCode = 1
}
