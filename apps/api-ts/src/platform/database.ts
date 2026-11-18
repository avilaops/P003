import { Pool, types, type PoolClient } from "pg"
import { z } from "zod"

import { Problem } from "./problem.js"
import { parseJson, stringifyJson } from "./json.js"

export type QueryRows<T extends Record<string, unknown> = Record<string, unknown>> = { rows: T[] }

export interface DatabaseClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryRows<T>>
  release(): void
}

export interface DatabasePool {
  connect(): Promise<DatabaseClient>
}

export type TenantContext = {
  client: DatabaseClient
  tenantId: string
  authSubject: string
  permissions: string[]
}

const tenantSchema = z.guid()
const authorizedAccessSql = `WITH platform_authority AS (
  SELECT EXISTS(SELECT 1 FROM platform_administrators WHERE auth_subject=$2 AND active) AS allowed
)
SELECT tenant.id AS tenant_id, tenant.legal_name, tenant.trade_name, ARRAY['platform_administrator']::text[] AS roles,
       ARRAY(SELECT code FROM permissions WHERE code NOT IN ('fiscal.cte.read','fiscal.cte.query','fiscal.cte.inspect',
         'fiscal.cte.link','fiscal.nfse.read','fiscal.nfse.import') ORDER BY code) AS permissions
FROM tenants tenant WHERE tenant.id=$1 AND tenant.status='active' AND (SELECT allowed FROM platform_authority)
UNION ALL
SELECT tenant.id AS tenant_id, tenant.legal_name, tenant.trade_name,
       COALESCE(array_agg(DISTINCT role.code) FILTER (WHERE role.code IS NOT NULL),'{}') AS roles,
       COALESCE(array_agg(DISTINCT role_permission.permission_code) FILTER (WHERE role_permission.permission_code IS NOT NULL),'{}') AS permissions
FROM tenants tenant
JOIN tenant_memberships membership ON membership.tenant_id=tenant.id
JOIN identities identity ON identity.id=membership.identity_id
LEFT JOIN membership_roles membership_role ON membership_role.membership_id=membership.id
LEFT JOIN roles role ON role.id=membership_role.role_id AND role.tenant_id=tenant.id
LEFT JOIN role_permissions role_permission ON role_permission.role_id=role.id
WHERE tenant.id=$1 AND identity.auth_subject=$2 AND tenant.status='active' AND membership.status='active'
  AND NOT (SELECT allowed FROM platform_authority)
GROUP BY tenant.id`
const permissionsSql = `SELECT tenant_id,permissions FROM (${authorizedAccessSql}) effective_access`

type AccessProfile = { tenant_id: string; legal_name: string; trade_name: string | null; roles: string[]; permissions: string[] }

export async function readAccessProfile(context: TenantContext) {
  const result = await context.client.query<AccessProfile>(authorizedAccessSql, [context.tenantId, context.authSubject])
  const row = result.rows[0]
  if (!row) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
  return { tenant: { id: row.tenant_id, legalName: row.legal_name, tradeName: row.trade_name }, roles: row.roles, permissions: row.permissions }
}

export async function reloadTenantPermissions(context: TenantContext) {
  const row = (await context.client.query<{ tenant_id: string; permissions: string[] }>(permissionsSql, [context.tenantId, context.authSubject])).rows[0]
  if (!row) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
  context.permissions = row.permissions
}

export async function withTenantTransaction<T>(
  pool: DatabasePool,
  tenantId: string,
  authSubject: string,
  operation: (context: TenantContext) => Promise<T>,
  write = false,
): Promise<T> {
  if (!tenantSchema.safeParse(tenantId).success) {
    throw new Problem(400, "invalid_tenant", "Identificador da empresa inválido")
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)",
      [tenantId, authSubject],
    )
    // Match Rust's lock order: serialize writes, then read current rights.
    if (write) await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId])
    const access = await client.query<{ tenant_id: string; permissions: string[] }>(permissionsSql, [tenantId, authSubject])
    const row = access.rows[0]
    if (!row) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
    const result = await operation({
      client,
      tenantId,
      authSubject,
      permissions: row.permissions,
    })
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* Preserve the original failure. */ }
    throw error
  } finally {
    client.release()
  }
}

export class PgClientAdapter implements DatabaseClient {
  constructor(private readonly client: PoolClient) {}
  async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryRows<T>> {
    const result = await this.client.query<T>({ text: sql, values: values.map(value => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !Buffer.isBuffer(value) ? stringifyJson(value) : value), types: { getTypeParser: (oid: number) => oid === 114 || oid === 3802 ? parseJson : types.getTypeParser(oid) } })
    return { rows: result.rows }
  }
  release() { this.client.release() }
}

export class PostgresPool implements DatabasePool {
  private readonly pool: Pool
  constructor(databaseUrl: string, maximumConnections: number) {
    this.pool = new Pool({ connectionString: databaseUrl, max: maximumConnections, connectionTimeoutMillis: 5000 })
  }
  async connect(): Promise<DatabaseClient> {
    return new PgClientAdapter(await this.pool.connect())
  }
  async close() { await this.pool.end() }
}
