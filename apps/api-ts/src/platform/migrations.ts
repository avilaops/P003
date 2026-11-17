import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Pool, PoolClient } from "pg"

type Migration = {
  version: bigint
  file: string
  description: string
  sql: string
  checksum: Buffer
}

type AppliedMigration = { version: string; success: boolean; checksum: Buffer }

export class MigrationError extends Error {}

const ledgerSql = `CREATE TABLE IF NOT EXISTS _sqlx_migrations (
  version BIGINT PRIMARY KEY,
  description TEXT NOT NULL,
  installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
  success BOOLEAN NOT NULL,
  checksum BYTEA NOT NULL,
  execution_time BIGINT NOT NULL
)`

async function loadMigrations(directory: string) {
  const forward = new Map<string, Migration>()
  const downVersions = new Set<string>()
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

  for (const file of await readdir(directory)) {
    const path = join(directory, file)
    const metadata = await stat(path)
    const separator = file.indexOf("_")
    if (!metadata.isFile() || separator < 0 || !file.endsWith(".sql")) continue

    const versionPrefix = file.slice(0, separator)
    if (!/^[+-]?[0-9]+$/.test(versionPrefix)) throw new MigrationError(`Invalid migration version in ${file}`)
    const version = BigInt(versionPrefix)
    if (BigInt.asIntN(64, version) !== version) throw new MigrationError(`Migration version out of range in ${file}`)
    const key = version.toString()

    let description = file.slice(separator + 1)
    const down = description.endsWith(".down.sql")
    const suffix = down ? ".down.sql" : description.endsWith(".up.sql") ? ".up.sql" : ".sql"
    while (description.endsWith(suffix)) description = description.slice(0, -suffix.length)
    if ((down ? downVersions : forward).has(key)) throw new MigrationError(`Duplicate migration version ${key} in ${file}`)

    const bytes = await readFile(path)
    let sql: string
    try {
      sql = decoder.decode(bytes)
    } catch (cause) {
      throw new MigrationError(`Invalid UTF-8 in migration ${file}`, { cause })
    }

    if (down) {
      downVersions.add(key)
    } else {
      forward.set(key, {
        version,
        file,
        description: description.replaceAll("_", " "),
        sql,
        checksum: createHash("sha384").update(bytes).digest(),
      })
    }
  }

  return forward
}

// SQLx PostgreSQL uses CRC-32/ISO-HDLC over the database name's UTF-8 bytes.
function sqlxLockId(database: string) {
  let crc = 0xffffffff
  for (const byte of Buffer.from(database, "utf8")) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (0x3d32ad9en * BigInt((crc ^ 0xffffffff) >>> 0)).toString()
}

async function applyMigration(client: PoolClient, migration: Migration) {
  const version = migration.version.toString()
  const startedAt = process.hrtime.bigint()
  const transactional = !migration.sql.startsWith("-- no-transaction")
  try {
    if (transactional) await client.query("BEGIN")
    await client.query(migration.sql)
    await client.query(
      `INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
       VALUES ($1, $2, TRUE, $3, -1)`,
      [version, migration.description, migration.checksum],
    )
    if (transactional) await client.query("COMMIT")
  } catch (cause) {
    if (transactional) {
      try { await client.query("ROLLBACK") } catch { /* The caller will destroy the session. */ }
    }
    throw new MigrationError(`Could not apply migration ${version} (${migration.file})`, { cause })
  }

  // SQLx measures the full transaction and records its duration after commit.
  const elapsed = process.hrtime.bigint() - startedAt
  await client.query("UPDATE _sqlx_migrations SET execution_time = $1 WHERE version = $2", [elapsed.toString(), version])
}

export async function runMigrations(pool: Pool, { directory }: { directory: string }): Promise<{ applied: string[]; existing: number }> {
  const migrations = await loadMigrations(directory)
  const ordered = [...migrations.values()].sort((a, b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
  const client = await pool.connect()

  try {
    const { rows: [current] } = await client.query<{ database: string }>("SELECT current_database() AS database")
    if (!current) throw new MigrationError("Could not determine the PostgreSQL database name")
    const lockId = sqlxLockId(current.database)
    await client.query("SELECT pg_advisory_lock($1::bigint)", [lockId])
    await client.query(ledgerSql)

    const { rows } = await client.query<AppliedMigration>(
      "SELECT version::text AS version, success, checksum FROM _sqlx_migrations ORDER BY _sqlx_migrations.version",
    )
    const dirty = rows.find(row => !row.success)
    if (dirty) throw new MigrationError(`Dirty migration ${dirty.version}`)

    const existing = new Set<string>()
    for (const row of rows) {
      const migration = migrations.get(row.version)
      if (!migration) throw new MigrationError(`Missing file for applied migration ${row.version}`)
      if (!migration.checksum.equals(row.checksum)) throw new MigrationError(`Checksum mismatch for applied migration ${row.version}`)
      existing.add(row.version)
    }

    const applied: string[] = []
    for (const migration of ordered) {
      const version = migration.version.toString()
      if (existing.has(version)) continue
      await applyMigration(client, migration)
      applied.push(version)
    }

    const { rows: [lock] } = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [lockId])
    if (!lock?.unlocked) throw new MigrationError("Could not release the SQLx migration lock")
    return { applied, existing: existing.size }
  } finally {
    // SQL files can leave session settings or advisory locks even on success.
    client.release(true)
  }
}
