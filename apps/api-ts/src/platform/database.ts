import { Pool, type PoolClient } from "pg"
import { z } from "zod"

import { Problem } from "./problem.js"

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

const tenantSchema = z.string().uuid()
const accessSql = "SELECT tenant.id AS tenant_id,COALESCE(array_agg(DISTINCT role_permission.permission_code) FILTER (WHERE role_permission.permission_code IS NOT NULL),'{}') AS permissions FROM tenants tenant JOIN tenant_memberships membership ON membership.tenant_id=tenant.id JOIN identities identity ON identity.id=membership.identity_id LEFT JOIN membership_roles membership_role ON membership_role.membership_id=membership.id LEFT JOIN roles role ON role.id=membership_role.role_id LEFT JOIN role_permissions role_permission ON role_permission.role_id=role.id WHERE tenant.id=$1 AND identity.auth_subject=$2 AND tenant.status='active' AND membership.status='active' GROUP BY tenant.id"

export async function withTenantTransaction<T>(
  pool: DatabasePool,
  tenantId: string,
  authSubject: string,
  operation: (context: TenantContext) => Promise<T>,
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
    const access = await client.query<{ tenant_id: string; permissions: string[] }>(accessSql, [tenantId, authSubject])
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

class PgClientAdapter implements DatabaseClient {
  constructor(private readonly client: PoolClient) {}
  async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryRows<T>> {
    const result = await this.client.query<T>(sql, [...values])
    return { rows: result.rows }
  }
  release() { this.client.release() }
}

export class PostgresPool implements DatabasePool {
  private readonly pool: Pool
  constructor(databaseUrl: string, maximumConnections: number) {
    this.pool = new Pool({ connectionString: databaseUrl, max: maximumConnections })
  }
  async connect(): Promise<DatabaseClient> {
    return new PgClientAdapter(await this.pool.connect())
  }
  async close() { await this.pool.end() }
}
