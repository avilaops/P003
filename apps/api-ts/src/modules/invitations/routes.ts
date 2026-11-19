import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { sameJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { deliveryFromEnvironment, type InvitationDelivery } from "./delivery.js"

const MANAGER_PERMISSIONS = ["platform.company.read", "platform.roles.read", "platform.users.manage", "platform.users.read"]
// Access-management errors use their own problem codes in the Rust API.
const invalid = (title: string) => new Problem(422, "invalid_access", title)
const conflict = (title: string) => new Problem(409, "access_conflict", title)
const notFound = () => new Problem(404, "not_found", "Recurso não encontrado nesta empresa")
const notConfigured = () => conflict("O envio de convites ainda não foi configurado")

function commandHeader(value: string | string[] | undefined) {
  if (value === undefined) throw new Problem(428, "idempotency_required", "Informe uma chave de idempotência para esta operação")
  const parsed = z.guid().safeParse(Array.isArray(value) ? undefined : value)
  if (!parsed.success) throw invalid("Informe uma chave válida para o convite")
  return parsed.data.toLowerCase()
}
const inputSchema = z.strictObject({ name: z.string(), email: z.string(), roleIds: z.array(z.guid()), manageUsers: z.boolean().default(false) })

function normalize(body: unknown) {
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) throw invalid("Convite inválido ou campos desconhecidos")
  const name = parsed.data.name.trim(), email = parsed.data.email.trim().toLowerCase()
  const roleIds = [...new Set(parsed.data.roleIds.map(id => id.toLowerCase()))].sort()
  const at = email.indexOf("@"), domain = email.slice(at + 1)
  if (!name || [...name].length > 120 || email.length > 254 || /\s/u.test(email) || at < 1 || !domain.includes(".") || domain.includes("@") || roleIds.length > 32 || roleIds.length === 0 && !parsed.data.manageUsers) {
    throw invalid("Informe nome, e-mail válido e ao menos um acesso")
  }
  return { name, email, roleIds, manageUsers: parsed.data.manageUsers }
}

const projection = `SELECT i.id, i.name, i.email,
  CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS status, i.delivery,
  to_char(i.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
  ARRAY(SELECT name FROM roles WHERE tenant_id = i.tenant_id AND id = ANY(i.role_ids) ORDER BY name) AS roles
  FROM user_invitations i`
type Invitation = { id: string; name: string; email: string; status: string; delivery: string; expiresAt: string; roles: string[] }
async function invitation(context: AuthorizedContext, id: string): Promise<Invitation> {
  const result = await context.client.query<Record<string, string & string[]>>(`${projection} WHERE i.tenant_id = $1 AND i.id = $2`, [context.tenantId, id])
  const row = result.rows[0]
  if (!row) throw notFound()
  return { id: row.id!, name: row.name!, email: row.email!, status: row.status!, delivery: row.delivery!, expiresAt: row.expires_at!, roles: row.roles! }
}
async function audit(context: AuthorizedContext, id: string, action: string) {
  await context.client.query("INSERT INTO audit_log (tenant_id, identity_id, action, entity_type, entity_id) SELECT $1, id, $3, 'user_invitation', $4 FROM identities WHERE auth_subject = $2", [context.tenantId, context.identity.subject, action, id])
  await context.client.query("INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, 'user_invitation', $2, $3, '{}'::jsonb)", [context.tenantId, id, action])
}
function withinAuthority(context: AuthorizedContext, permissions: readonly string[]) {
  if (permissions.some(code => !context.permissions.includes(code))) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
}
async function rolePermissions(context: AuthorizedContext, id: string) {
  const result = await context.client.query<{ permissions: string[] }>("SELECT COALESCE(array_agg(p.permission_code ORDER BY p.permission_code) FILTER (WHERE p.permission_code IS NOT NULL), '{}') AS permissions FROM roles r LEFT JOIN role_permissions p ON p.role_id = r.id WHERE r.tenant_id = $1 AND r.id = $2 GROUP BY r.id", [context.tenantId, id])
  if (!result.rows[0]) throw notFound()
  return result.rows[0].permissions
}
async function managerRole(context: AuthorizedContext) {
  withinAuthority(context, MANAGER_PERMISSIONS)
  const created = await context.client.query<{ id: string }>("INSERT INTO roles (tenant_id, code, name, description) VALUES ($1, 'user-manager', 'Gestor de usuários', 'Convidar e gerenciar usuários, consultar papéis e dados da empresa') ON CONFLICT (tenant_id, code) DO UPDATE SET code = EXCLUDED.code RETURNING id", [context.tenantId])
  const id = created.rows[0]!.id, current = await rolePermissions(context, id)
  if (current.length === 0) await context.client.query("INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[])", [id, MANAGER_PERMISSIONS])
  else if (current.join() !== MANAGER_PERMISSIONS.join()) throw conflict("O papel Gestor de usuários foi personalizado. Selecione os papéis manualmente")
  return id
}
async function selectedPermissions(context: AuthorizedContext, ids: readonly string[]) {
  const all = new Set<string>()
  for (const id of ids) {
    const permissions = await rolePermissions(context, id)
    withinAuthority(context, permissions)
    for (const permission of permissions) all.add(permission)
  }
  return [...all].sort()
}
async function companyName(context: AuthorizedContext) {
  return (await context.client.query<{ legal_name: string }>("SELECT legal_name FROM tenants WHERE id = $1", [context.tenantId])).rows[0]!.legal_name
}

// `invitationDelivery` lets tests (or a future AppDependencies field) replace Auth; `null` means not configured.
type Injected = AppDependencies & { invitationDelivery?: InvitationDelivery | null }

export function registerInvitationRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  const injected = (dependencies as Injected).invitationDelivery
  const delivery = injected === undefined ? deliveryFromEnvironment() : injected ?? undefined
  // Auth is contacted only after the invitation is committed, so a delivered e-mail always has a stored invitation.
  const finish = (request: Parameters<typeof authorizeRequest>[0], id: string, command: string, outcome: string) =>
    authorizeRequest(request, dependencies, async context => {
      await context.client.query("UPDATE user_invitations SET delivery = $4 WHERE tenant_id = $1 AND id = $2 AND delivery_key = $3", [context.tenantId, id, command, outcome])
      return invitation(context, id)
    }, true)

  app.get("/api/v1/invitations", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.read")
      const rows = await context.client.query<Record<string, string & string[]>>(`${projection} WHERE i.tenant_id = $1 ORDER BY i.created_at DESC LIMIT 200`, [context.tenantId])
      return { data: rows.rows.map(row => ({ id: row.id, name: row.name, email: row.email, status: row.status, delivery: row.delivery, expiresAt: row.expires_at, roles: row.roles })), enabled: delivery !== undefined }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post("/api/v1/invitations", async (request, reply) => {
    if (!delivery) throw notConfigured()
    const key = commandHeader(request.headers["idempotency-key"])
    const input = normalize(request.body)
    const stored = { name: input.name, email: input.email, roleIds: input.roleIds, manageUsers: input.manageUsers }
    const step = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.manage")
      requirePermission(context, "platform.users.read")
      requirePermission(context, "platform.roles.read")
      const previous = await context.client.query<{ id: string; request: unknown }>("SELECT id, request FROM user_invitations WHERE tenant_id = $1 AND command_key = $2", [context.tenantId, key])
      if (previous.rows[0]) {
        if (!sameJson(previous.rows[0].request, stored)) throw conflict("Chave já utilizada com outro convite")
        return { replay: await invitation(context, previous.rows[0].id) }
      }
      const exists = await context.client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM tenant_memberships m JOIN identities i ON i.id = m.identity_id WHERE m.tenant_id = $1 AND lower(i.email) = $2) OR EXISTS(SELECT 1 FROM user_invitations WHERE tenant_id = $1 AND email = $2 AND status = 'pending') AS exists", [context.tenantId, input.email])
      if (exists.rows[0]?.exists) throw conflict("Este e-mail já possui um acesso ou convite nesta empresa. Consulte a lista de usuários")
      const roleIds = [...input.roleIds]
      if (input.manageUsers) {
        const manager = await managerRole(context)
        if (!roleIds.includes(manager)) roleIds.push(manager)
      }
      const ceiling = await selectedPermissions(context, roleIds)
      const id = randomUUID()
      await context.client.query("INSERT INTO user_invitations (id, tenant_id, name, email, invited_by, role_ids, permission_ceiling, command_key, delivery_key, request) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)", [id, context.tenantId, input.name, input.email, context.identity.subject, roleIds, ceiling, key, stored])
      await audit(context, id, "user_invitation.created")
      return { created: await invitation(context, id), company: await companyName(context), inviter: context.identity.name }
    }, true)
    if ("replay" in step) return reply.header("cache-control", "no-store").send(step.replay)
    const outcome = await delivery.send(step.created, step.company, step.inviter)
    return reply.header("cache-control", "no-store").send(await finish(request, step.created.id, key, outcome))
  })

  app.post<{ Params: { id: string } }>("/api/v1/invitations/:id/resend", async (request, reply) => {
    if (!delivery) throw notConfigured()
    const command = commandHeader(request.headers["idempotency-key"])
    const step = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.manage")
      requirePermission(context, "platform.users.read")
      requirePermission(context, "platform.roles.read")
      if (!z.guid().safeParse(request.params.id).success) throw notFound()
      const value = await invitation(context, request.params.id)
      const state = await context.client.query<{ delivery_key: string; ready: boolean; role_ids: string[] }>("SELECT delivery_key, last_delivery_at < now() - interval '60 seconds' AS ready, role_ids FROM user_invitations WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [context.tenantId, value.id])
      const row = state.rows[0]!
      if (row.delivery_key === command) return { replay: value }
      if (value.status !== "pending" || !row.ready) throw conflict("O convite precisa estar válido. Aguarde um minuto entre os envios")
      await selectedPermissions(context, row.role_ids)
      await context.client.query("UPDATE user_invitations SET delivery = 'sending', delivery_key = $3, last_delivery_at = now() WHERE tenant_id = $1 AND id = $2", [context.tenantId, value.id, command])
      await audit(context, value.id, "user_invitation.resent")
      return { sending: value, company: await companyName(context), inviter: context.identity.name }
    }, true)
    if ("replay" in step) return reply.header("cache-control", "no-store").send(step.replay)
    const outcome = await delivery.send(step.sending, step.company, step.inviter)
    return reply.header("cache-control", "no-store").send(await finish(request, step.sending.id, command, outcome))
  })

  app.post<{ Params: { id: string } }>("/api/v1/invitations/:id/revoke", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.manage")
      if (!z.guid().safeParse(request.params.id).success) throw notFound()
      const value = await invitation(context, request.params.id)
      if (value.status === "accepted") throw conflict("O convite já foi aceito. Gerencie o acesso pela lista de usuários")
      await context.client.query("UPDATE user_invitations SET status = 'revoked' WHERE tenant_id = $1 AND id = $2", [context.tenantId, value.id])
      await audit(context, value.id, "user_invitation.revoked")
      return invitation(context, value.id)
    }, true)
    return reply.header("cache-control", "no-store").send(body)
  })
}
