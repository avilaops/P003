import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { gzipSync } from "node:zlib"
import { Pool } from "pg"

import { runMigrations } from "../src/platform/migrations.js"

const adminUrl = process.env.API_TS_TEST_ADMIN_URL
const integration = { skip: !adminUrl }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "api-ts-migrate-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const database = `api_ts_migrate_${randomUUID().replaceAll("-", "")}_ç`
  const url = new URL(adminUrl!)
  const admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 15000 })
  let pool: Pool | undefined
  t.after(async () => {
    try {
      if (pool) {
        await pool.end()
        await admin.query(`DROP DATABASE "${database}"`)
      }
    } finally {
      await admin.end()
    }
  })
  await admin.query(`CREATE DATABASE "${database}"`)
  url.pathname = `/${database}`
  url.searchParams.delete("database")
  pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 15000 })

  return { pool, directory, database, write: (name: string, sql: string | Buffer) => writeFile(join(directory, name), sql) }
}

async function seedLedger(pool: Pool, version: string, sql: string, success = true) {
  await pool.query(`CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
    success BOOLEAN NOT NULL,
    checksum BYTEA NOT NULL,
    execution_time BIGINT NOT NULL
  )`)
  await pool.query(
    `INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
     VALUES ($1, 'original SQLx row', '2026-01-01T00:00:00Z', $2, $3, 42)`,
    [version, success, createHash("sha384").update(sql).digest()],
  )
}

async function hasTable(pool: Pool, name: string) {
  return (await pool.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [name])).rows[0]?.exists
}

async function waitForLockCount(pool: Pool, expected: number, granted: boolean) {
  const deadline = Date.now() + 10000
  let count: number | undefined
  do {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
       WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND granted = $1`,
      [granted],
    )
    count = result.rows[0]?.count
    if (count === expected) return
    await delay(20)
  } while (Date.now() < deadline)
  assert.equal(count, expected, "advisory lock count")
}

test("preserves the SQLx ledger and appends exact SHA384 checksums for BIGINT versions", integration, async t => {
  const { pool, directory, write } = await fixture(t)
  const oldVersion = "9007199254740992"
  const newVersion = "9007199254740993"
  const oldSql = "SELECT nonexistent_function();\r\n"
  const newSql = "-- conteúdo UTF-8\r\nCREATE TABLE migrated (id int);\r\n"
  await seedLedger(pool, oldVersion, oldSql)
  await write(`${oldVersion}_already_applied.sql`, oldSql)
  await write(`${newVersion}_new_table.up.sql`, newSql)
  await write(`${newVersion}_new_table.down.sql`, "DROP TABLE migrated;")
  await write("README.md", "not SQL")
  await mkdir(join(directory, "9007199254740994_directory.sql"))

  assert.deepEqual(await runMigrations(pool, { directory }), { applied: [newVersion], existing: 1 })
  assert.deepEqual(await runMigrations(pool, { directory }), { applied: [], existing: 2 })
  assert.equal(await hasTable(pool, "migrated"), true)
  const { rows: [oldRow, newRow] } = await pool.query("SELECT * FROM _sqlx_migrations ORDER BY version")
  assert.deepEqual(oldRow, {
    version: oldVersion,
    description: "original SQLx row",
    installed_on: new Date("2026-01-01T00:00:00Z"),
    success: true,
    checksum: createHash("sha384").update(oldSql).digest(),
    execution_time: "42",
  })
  assert.equal(newRow?.version, newVersion)
  assert.equal(newRow?.description, "new table")
  assert.equal(newRow?.success, true)
  assert.deepEqual(newRow?.checksum, createHash("sha384").update(newSql).digest())
  assert.ok(BigInt(newRow?.execution_time) >= 0n)
})

for (const scenario of ["checksum", "dirty", "missing"] as const) {
  test(`blocks pending SQL before running it when the ledger is ${scenario}`, integration, async t => {
    const { pool, directory, write } = await fixture(t)
    await seedLedger(pool, "10", "SELECT 1;\r\n", scenario !== "dirty")
    await write("2_pending.sql", "CREATE TABLE must_not_exist (id int);")
    if (scenario === "missing") await write("10_prior.down.sql", "SELECT 1;\r\n")
    else await write("10_prior.sql", scenario === "checksum" ? "SELECT 1;\n" : "SELECT 1;\r\n")

    await assert.rejects(runMigrations(pool, { directory }), new RegExp(`${scenario}.*10|10.*${scenario}`, "i"))
    assert.equal(await hasTable(pool, "must_not_exist"), false)
    assert.equal((await pool.query("SELECT version FROM _sqlx_migrations")).rows[0]?.version, "10")
    await waitForLockCount(pool, 0, true)
  })
}

test("rolls back a failed file and ledger entry, then retries from the last committed file", integration, async t => {
  const { pool, directory, write } = await fixture(t)
  await write("2_preceding.sql", "CREATE TABLE preceding (id int PRIMARY KEY);")
  await write("10_broken.sql", "CREATE TABLE partial (id int); INSERT INTO preceding VALUES (1), (1);")

  await assert.rejects(runMigrations(pool, { directory }), /10.*broken/)
  assert.equal(await hasTable(pool, "preceding"), true)
  assert.equal(await hasTable(pool, "partial"), false)
  assert.deepEqual((await pool.query("SELECT version FROM _sqlx_migrations")).rows, [{ version: "2" }])
  await waitForLockCount(pool, 0, true)

  await write("10_broken.sql", "CREATE TABLE partial (id int); INSERT INTO preceding VALUES (1);")
  assert.deepEqual(await runMigrations(pool, { directory }), { applied: ["10"], existing: 1 })
})

test("uses the exact SQLx lock and applies the migration once across concurrent calls", integration, async t => {
  const { pool, database, directory, write } = await fixture(t)
  await write("1_lock_test.sql", "CREATE TABLE once_only (id int);")
  const gzip = gzipSync(database)
  const checksum = gzip.readUInt32LE(gzip.length - 8)
  const lockId = (0x3d32ad9en * BigInt(checksum)).toString()
  const blocker = await pool.connect()
  let runs: Promise<PromiseSettledResult<Awaited<ReturnType<typeof runMigrations>>>[]> | undefined
  try {
    await blocker.query("SELECT pg_advisory_lock($1::bigint)", [lockId])
    runs = Promise.allSettled([runMigrations(pool, { directory }), runMigrations(pool, { directory })])
    await waitForLockCount(pool, 2, false)
    assert.equal(await hasTable(pool, "_sqlx_migrations"), false)
  } finally {
    try {
      await blocker.query("SELECT pg_advisory_unlock($1::bigint)", [lockId])
    } finally {
      blocker.release(true)
      await runs
    }
  }
  const results = (await runs).map(result => {
    if (result.status === "rejected") throw result.reason
    return result.value
  })
  assert.deepEqual(results.sort((a, b) => a.existing - b.existing), [
    { applied: ["1"], existing: 0 }, { applied: [], existing: 1 },
  ])
  await waitForLockCount(pool, 0, true)
})

test("does not return migration session locks to the pool", integration, async t => {
  const { pool, directory, write } = await fixture(t)
  await write("1_session_lock.sql", "SELECT pg_advisory_lock(981745815::bigint);")

  assert.deepEqual(await runMigrations(pool, { directory }), { applied: ["1"], existing: 0 })
  await waitForLockCount(pool, 0, true)
})

test("honors the SQLx no-transaction directive for concurrent index creation", integration, async t => {
  const { pool, directory, write } = await fixture(t)
  await write("001_indexed.sql", "CREATE TABLE indexed (id int);")
  await write("2_index.sql", "-- no-transaction\nCREATE INDEX CONCURRENTLY indexed_id ON indexed(id);")
  await write("3_index.sql", "\n-- no-transaction\nCREATE INDEX CONCURRENTLY indexed_id2 ON indexed(id);")

  await assert.rejects(runMigrations(pool, { directory }), /3.*index/)
  assert.equal(await hasTable(pool, "indexed_id"), true)
  assert.equal(await hasTable(pool, "indexed_id2"), false)
  assert.deepEqual((await pool.query("SELECT version FROM _sqlx_migrations ORDER BY version")).rows, [{ version: "1" }, { version: "2" }])
})

test("rejects ambiguous forward versions before applying SQL", integration, async t => {
  const { pool, directory, write } = await fixture(t)
  await write("1_pending.sql", "CREATE TABLE must_not_exist (id int);")
  await write("2_add_one.sql", "SELECT 1;")
  await write("+02_add_two.up.sql", "SELECT 2;")

  await assert.rejects(runMigrations(pool, { directory }), /duplicate.*2/i)
  assert.equal(await hasTable(pool, "must_not_exist"), false)
})

for (const [name, sql, message] of [
  ["9223372036854775808_range.sql", "SELECT 1;", /version/i],
  ["one_bad_version.sql", "SELECT 1;", /version/i],
  ["10_invalid_utf8.sql", Buffer.from([0xff]), /UTF-8/i],
] as const) {
  test(`rejects ${name} before applying SQL`, integration, async t => {
    const { pool, directory, write } = await fixture(t)
    await write("1_pending.sql", "CREATE TABLE must_not_exist (id int);")
    await write(name, sql)

    await assert.rejects(runMigrations(pool, { directory }), message)
    assert.equal(await hasTable(pool, "must_not_exist"), false)
  })
}
