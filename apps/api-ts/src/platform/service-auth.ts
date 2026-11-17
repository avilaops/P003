import { createHash } from "node:crypto"

import type { AuthorizedContext } from "./access.js"
import type { DatabasePool } from "./database.js"
import { Problem } from "./problem.js"

type RequestLike = { method?: string; headers: Record<string, string | string[] | undefined> }
const serviceKey = /^erp_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{64})$/i
const permissions = ["fiscal.outgoing_nfse.read", "fiscal.outgoing_nfse.issue", "fiscal.outgoing_nfse.cancel"]

function one(value: string | string[] | undefined) { return Array.isArray(value) ? undefined : value }

export async function authorizeServiceRequest<T>(request: RequestLike, pool: DatabasePool, operation: (context: AuthorizedContext) => Promise<T>): Promise<T> {
  const authorization = one(request.headers.authorization)
  const parsed = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim().match(serviceKey)
  if (!parsed) throw new Problem(401, "invalid_service_key", "Credencial de integração inválida ou revogada")
  const tenantId = parsed[1]!.toLowerCase()
  const declaredTenant = one(request.headers["x-tenant-id"])
  if (!declaredTenant || declaredTenant.toLowerCase() !== tenantId) throw new Problem(403, "service_tenant_mismatch", "Credencial de integração não pertence à empresa informada")
  const hash = createHash("sha256").update(authorization!.slice(authorization!.indexOf(" ") + 1).trim()).digest()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)", [tenantId, "service:pending"])
    if (request.method && !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId])
    const row = (await client.query<{ id: string }>("SELECT id FROM service_api_keys WHERE tenant_id=$1 AND key_hash=$2 AND revoked_at IS NULL", [tenantId, hash])).rows[0]
    if (!row) throw new Problem(401, "invalid_service_key", "Credencial de integração inválida ou revogada")
    const subject = `service:${row.id}`
    await client.query("SELECT set_config('app.auth_subject',$1,true)", [subject])
    await client.query("UPDATE service_api_keys SET last_used_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [row.id, tenantId])
    const result = await operation({ client, tenantId, authSubject: subject, permissions: [...permissions], identity: { subject, email: "service@erp.internal", name: "Integração", emailVerified: true } })
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* Preserve the original failure. */ }
    throw error
  } finally { client.release() }
}
