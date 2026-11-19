import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authenticateRequest, authorizeRequest, requirePermission } from "../../platform/access.js"
import type { DatabaseClient } from "../../platform/database.js"
import { sameJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue, type Revision } from "../../platform/revision.js"
import { companySchema, emptyCompany, toCompanyData, validateCompany, type CompanyData, type FieldError } from "./schema.js"

// Contrato do Rust (platform/company.rs e platform/onboarding.rs). Os erros de empresa levam `errors`.
class CompanyProblem extends Problem {
  constructor(status: number, code: string, title: string, readonly errors: FieldError[] = []) { super(status, code, title) }
  override toJSON() { return { ...super.toJSON(), errors: this.errors } }
}
const validationProblem = (errors: FieldError[]) => new CompanyProblem(422, "validation_error", "Confira os campos informados", errors)
const maximumRevision = 9223372036854775807n

// A revisão 0 é válida: a empresa ainda sem perfil salvo.
function ifMatch(value: string | string[] | undefined): Revision {
  if (value === undefined) throw new CompanyProblem(428, "revision_required", "Recarregue os dados antes de salvar")
  const match = typeof value === "string" ? /^"([0-9]+)"$/.exec(value) : null
  if (!match?.[1] || BigInt(match[1]) > maximumRevision) throw new CompanyProblem(400, "invalid_revision", "Revisão inválida")
  return revisionValue(BigInt(match[1]))
}

function parseCompany(body: unknown): CompanyData {
  const parsed = companySchema.safeParse(body)
  if (!parsed.success) throw validationProblem([{ field: "body", message: "JSON inválido ou campos desconhecidos" }])
  return toCompanyData(parsed.data)
}

type Stored = { revision: Revision; details: Partial<CompanyData> }
async function loadCompany(client: DatabaseClient, tenantId: string) {
  const result = await client.query<Record<string, unknown>>(
    "SELECT t.legal_name, t.trade_name, t.tax_id, COALESCE(p.revision, 0) AS revision, COALESCE(p.details, '{}'::jsonb) AS details FROM tenants t LEFT JOIN company_profiles p ON p.tenant_id = t.id WHERE t.id = $1",
    [tenantId],
  )
  const row = result.rows[0]
  if (!row) throw new Problem(500, "internal_error", "Erro interno")
  const stored: Stored = { revision: revisionValue(row.revision), details: row.details as Partial<CompanyData> }
  const data: CompanyData = { ...emptyCompany(), ...stored.details, legalName: row.legal_name as string, tradeName: (row.trade_name as string | null) ?? "", taxId: row.tax_id as string }
  if (!data.personType) data.personType = [...data.taxId].filter(char => /^[A-Za-z0-9]$/.test(char)).length === 11 ? "fisica" : "juridica"
  return { stored, data }
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
}

export function registerCompanyRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/company", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.company.read")
      const { stored, data } = await loadCompany(context.client, context.tenantId)
      return { tenantId: context.tenantId, revision: stored.revision, canEdit: context.permissions.includes("platform.company.manage"), data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })

  app.put("/api/v1/company", async (request, reply) => {
    const expected = ifMatch(request.headers["if-match"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.company.manage")
      requirePermission(context, "platform.company.read")
      const data = parseCompany(request.body)
      const errors = validateCompany(data)
      if (errors.length) throw validationProblem(errors)
      const previous = await loadCompany(context.client, context.tenantId)
      if (BigInt(previous.stored.revision) !== BigInt(expected)) throw new CompanyProblem(412, "revision_conflict", "Outra pessoa alterou estes dados. Sua edição foi preservada")
      // Clientes antigos omitem marca e sócio: a omissão preserva; string vazia limpa.
      const saved = previous.stored.details
      for (const key of ["partnerName", "partnerMobile", "logoDataUrl"] as const) {
        const kept = data[key] ?? saved[key]
        if (kept === undefined) delete data[key]
        else data[key] = kept
      }
      try {
        await context.client.query("UPDATE tenants SET legal_name = $2, trade_name = NULLIF($3, ''), tax_id = $4, updated_at = now() WHERE id = $1", [context.tenantId, data.legalName, data.tradeName, data.taxId])
      } catch (error) {
        if (isUniqueViolation(error)) throw new CompanyProblem(409, "tax_id_unavailable", "Documento indisponível para este cadastro")
        throw error
      }
      const next = BigInt(previous.stored.revision) + 1n
      if (next > maximumRevision) throw new Problem(500, "internal_error", "Erro interno")
      await context.client.query("INSERT INTO company_profiles (tenant_id, revision, details) VALUES ($1, $2, $3) ON CONFLICT (tenant_id) DO UPDATE SET revision = EXCLUDED.revision, details = EXCLUDED.details, updated_at = now()", [context.tenantId, next.toString(), data])
      const metadata = { previousRevision: expected, revision: revisionValue(next) }
      const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : null
      await context.client.query("INSERT INTO audit_log (tenant_id, identity_id, action, entity_type, entity_id, request_id, details) SELECT $1::uuid, id, 'company.updated', 'company', $1::uuid::text, $3, $4 FROM identities WHERE auth_subject = $2", [context.tenantId, context.authSubject, requestId, metadata])
      await context.client.query("INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1::uuid, 'company', $1::uuid::text, 'company.updated', $2)", [context.tenantId, metadata])
      const loaded = await loadCompany(context.client, context.tenantId)
      return { tenantId: context.tenantId, revision: loaded.stored.revision, canEdit: true, data: loaded.data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })

  // Seleção de empresa: só quem pertence à empresa (ou administra a plataforma) passa em authorizeRequest.
  app.post("/api/v1/company-selection", async (request, reply) => {
    await authorizeRequest(request, dependencies, async context => {
      const administrator = await context.client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM platform_administrators WHERE auth_subject = $1 AND active) AS exists", [context.authSubject])
      await context.client.query("INSERT INTO audit_log (tenant_id, identity_id, action, entity_type, entity_id, details) VALUES ($1::uuid, (SELECT id FROM identities WHERE auth_subject=$2), 'platform.tenant.selected', 'company', $1::uuid::text, $3)", [context.tenantId, context.authSubject, { platformAdministrator: administrator.rows[0]?.exists === true }])
    }, false)
    return reply.code(204).header("cache-control", "no-store").send()
  })

  app.get("/api/v1/companies", async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies)
    const body = await withIdentityTransaction(dependencies, identity.subject, async client => {
      const admin = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM platform_administrators WHERE auth_subject = $1 AND active) AS exists", [identity.subject])
      const platformAdministrator = admin.rows[0]?.exists === true
      const companies = await client.query<Record<string, unknown>>(
        "SELECT t.id, t.legal_name, t.trade_name, t.status FROM tenants t WHERE $2 OR (t.status = 'active' AND EXISTS (SELECT 1 FROM tenant_memberships m JOIN identities i ON i.id = m.identity_id WHERE m.tenant_id = t.id AND m.status = 'active' AND i.auth_subject = $1)) ORDER BY t.legal_name, t.id",
        [identity.subject, platformAdministrator],
      )
      return { data: companies.rows.map(row => ({ id: row.id, legalName: row.legal_name, tradeName: row.trade_name, status: row.status })), platformAdministrator }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post("/api/v1/companies", async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies)
    const rawKey = request.headers["idempotency-key"]
    if (rawKey === undefined) throw new Problem(428, "idempotency_required", "Chave de repetição obrigatória")
    if (typeof rawKey !== "string" || !z.guid().safeParse(rawKey).success) throw new Problem(400, "invalid_idempotency_key", "Chave de repetição inválida")
    const key = rawKey.toLowerCase()
    const data = parseCompany(request.body)
    const errors = validateCompany(data)
    if (errors.length) throw validationProblem(errors)
    const result = await withIdentityTransaction(dependencies, identity.subject, async client => {
      // Serializa repetições desta identidade/chave sem reservar empresa parcialmente criada.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${identity.subject}:${key}`])
      const previous = await client.query<{ request: unknown; result: unknown }>("SELECT request, result FROM company_creation_commands WHERE auth_subject = $1 AND command_key = $2", [identity.subject, key])
      if (previous.rows[0]) {
        if (!sameJson(previous.rows[0].request, data)) throw new Problem(409, "idempotency_conflict", "Chave já utilizada com outros dados")
        return previous.rows[0].result
      }
      const tenantId = randomUUID()
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      try {
        await client.query("INSERT INTO tenants (id, legal_name, trade_name, tax_id) VALUES ($1, $2, NULLIF($3, ''), $4)", [tenantId, data.legalName, data.tradeName, data.taxId])
      } catch (error) {
        if (isUniqueViolation(error)) throw new CompanyProblem(409, "tax_id_unavailable", "Documento indisponível para este cadastro")
        throw error
      }
      const identityRow = await client.query<{ id: string }>("INSERT INTO identities (auth_subject, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (auth_subject) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now() RETURNING id", [identity.subject, identity.email, identity.name])
      const identityId = identityRow.rows[0]!.id, membershipId = randomUUID(), roleId = randomUUID()
      await client.query("INSERT INTO tenant_memberships (id, tenant_id, identity_id) VALUES ($1, $2, $3)", [membershipId, tenantId, identityId])
      await client.query("INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, 'admin', 'Administrador')", [roleId, tenantId])
      await client.query("INSERT INTO role_permissions (role_id, permission_code) SELECT $1, code FROM permissions WHERE code NOT IN ('fiscal.cte.read','fiscal.cte.query','fiscal.cte.inspect','fiscal.cte.link','fiscal.nfse.read','fiscal.nfse.import')", [roleId])
      await client.query("INSERT INTO membership_roles (membership_id, role_id) VALUES ($1, $2)", [membershipId, roleId])
      await client.query("INSERT INTO company_profiles (tenant_id, revision, details) VALUES ($1, 1, $2)", [tenantId, data])
      const metadata = { revision: 1, membershipId }
      await client.query("INSERT INTO audit_log (tenant_id, identity_id, action, entity_type, entity_id, details) VALUES ($1::uuid, $2, 'company.created', 'company', $1::uuid::text, $3)", [tenantId, identityId, metadata])
      await client.query("INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1::uuid, 'company', $1::uuid::text, 'company.created', $2)", [tenantId, metadata])
      const created = { tenantId, revision: 1 }
      await client.query("INSERT INTO company_creation_commands (auth_subject, command_key, tenant_id, request, result) VALUES ($1, $2, $3, $4, $5)", [identity.subject, key, tenantId, data, created])
      return created
    })
    return reply.code(201).header("cache-control", "no-store").send(result)
  })
}

// Transação sem empresa ativa: só a identidade vale (descoberta de empresas e criação).
async function withIdentityTransaction<T>(dependencies: AppDependencies, subject: string, operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await dependencies.pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id', '', true), set_config('app.auth_subject', $1, true)", [subject])
    const result = await operation(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* Preserve the original failure. */ }
    throw error
  } finally { client.release() }
}
