import { randomUUID } from "node:crypto"

import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { sameJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"

// Contrato do Rust (platform/access.rs e platform/access_management.rs): papéis e membros da empresa.
const ADMIN_PERMISSIONS = ["platform.users.read", "platform.users.manage", "platform.roles.read", "platform.roles.manage"]
const invalid = (title: string) => new Problem(422, "invalid_access", title)
const conflict = (title: string) => new Problem(409, "access_conflict", title)
const stale = () => new Problem(412, "revision_conflict", "Outra pessoa alterou estes dados. Sua edição foi preservada")
const badId = () => new Problem(400, "invalid_id", "Identificador inválido")
const idSchema = z.guid()

const roleSchema = z.strictObject({
  code: z.string(), name: z.string(), description: z.string().default(""), permissions: z.array(z.string()),
})
type RoleInput = z.infer<typeof roleSchema>
const memberSchema = z.strictObject({ status: z.string(), roleIds: z.array(z.guid()) })

type RoleDetail = { id: string; code: string; name: string; description: string; revision: number | bigint; permissions: string[] }
type MemberDetail = { id: string; name: string; email: string; status: string; revision: number | bigint; roleIds: string[] }

function pathId(value: string) {
  if (!idSchema.safeParse(value).success) throw badId()
  return value.toLowerCase()
}

function send(reply: FastifyReply, code: number, revision: number | bigint, body: unknown) {
  return reply.code(code).header("cache-control", "no-store").header("etag", `"${revision}"`).send(body)
}

async function loadRole(context: AuthorizedContext, id: string): Promise<RoleDetail> {
  const result = await context.client.query<Record<string, unknown>>(
    "SELECT r.id, r.code, r.name, r.description, r.revision, COALESCE(array_agg(p.permission_code ORDER BY p.permission_code) FILTER (WHERE p.permission_code IS NOT NULL), '{}') AS permissions FROM roles r LEFT JOIN role_permissions p ON p.role_id = r.id WHERE r.tenant_id = $1 AND r.id = $2 GROUP BY r.id",
    [context.tenantId, id],
  )
  const row = result.rows[0]
  if (!row) throw new Problem(404, "not_found", "Recurso não encontrado nesta empresa")
  return { id: row.id as string, code: row.code as string, name: row.name as string, description: row.description as string, revision: revisionValue(row.revision), permissions: row.permissions as string[] }
}

async function loadMember(context: AuthorizedContext, id: string): Promise<MemberDetail> {
  const result = await context.client.query<Record<string, unknown>>(
    "SELECT m.id, i.display_name AS name, i.email, CASE m.status WHEN 'active' THEN 'active' WHEN 'invited' THEN 'pending' ELSE 'blocked' END AS status, m.revision, COALESCE(array_agg(mr.role_id ORDER BY mr.role_id) FILTER (WHERE mr.role_id IS NOT NULL), '{}') AS role_ids FROM tenant_memberships m JOIN identities i ON i.id = m.identity_id LEFT JOIN membership_roles mr ON mr.membership_id = m.id WHERE m.tenant_id = $1 AND m.id = $2 GROUP BY m.id, i.display_name, i.email",
    [context.tenantId, id],
  )
  const row = result.rows[0]
  if (!row) throw new Problem(404, "not_found", "Recurso não encontrado nesta empresa")
  return { id: row.id as string, name: row.name as string, email: row.email as string, status: row.status as string, revision: revisionValue(row.revision), roleIds: row.role_ids as string[] }
}

function withinAuthority(context: AuthorizedContext, permissions: string[]) {
  if (permissions.some(code => !context.permissions.includes(code))) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
}

async function ensureAdministrator(context: AuthorizedContext) {
  const result = await context.client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT m.id FROM tenant_memberships m JOIN membership_roles mr ON mr.membership_id = m.id JOIN role_permissions rp ON rp.role_id = mr.role_id WHERE m.tenant_id = $2 AND m.status = 'active' GROUP BY m.id HAVING array_agg(DISTINCT rp.permission_code) @> $1::text[]) AS exists",
    [ADMIN_PERMISSIONS, context.tenantId],
  )
  if (!result.rows[0]?.exists) throw conflict("A empresa precisa manter ao menos um administrador ativo de usuários e papéis")
}

function validateRole(input: RoleInput): RoleInput {
  const name = input.name.trim(), description = input.description.trim()
  if (!/^[a-z0-9_-]{1,80}$/.test(input.code) || !name || Buffer.byteLength(name) > 120 || Array.from(description).length > 1000) throw invalid("Informe código, nome e descrição válidos")
  if (input.permissions.length > 256 || new Set(input.permissions).size !== input.permissions.length) throw invalid("Permissões repetidas ou quantidade inválida")
  for (const code of input.permissions) {
    if (code.endsWith(".manage") && !input.permissions.includes(`${code.slice(0, -".manage".length)}.read`)) throw invalid("A permissão de gerenciar exige a permissão de consultar correspondente")
  }
  return { code: input.code, name, description, permissions: [...input.permissions].sort() }
}

function parseRole(body: unknown) {
  const parsed = roleSchema.safeParse(body)
  if (!parsed.success) throw invalid("JSON inválido ou campos desconhecidos")
  return validateRole(parsed.data)
}

async function replacePermissions(context: AuthorizedContext, id: string, codes: string[]) {
  const known = await context.client.query<{ total: string }>("SELECT count(*)::text AS total FROM permissions WHERE code = ANY($1)", [codes])
  if (Number(known.rows[0]?.total) !== codes.length) throw invalid("Permissão não reconhecida pelo ERP")
  await context.client.query("DELETE FROM role_permissions WHERE role_id = $1", [id])
  await context.client.query("INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[])", [id, codes])
}

function uniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505"
}

export function registerAccessRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/users", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.read")
      const users = await context.client.query<Record<string, unknown>>(
        "SELECT membership.id, identity.display_name AS name, identity.email, CASE membership.status WHEN 'active' THEN 'active' WHEN 'invited' THEN 'pending' ELSE 'blocked' END AS status, COALESCE(array_agg(DISTINCT role.name) FILTER (WHERE role.name IS NOT NULL), '{}') AS roles FROM tenant_memberships membership JOIN identities identity ON identity.id = membership.identity_id LEFT JOIN membership_roles membership_role ON membership_role.membership_id = membership.id LEFT JOIN roles role ON role.id = membership_role.role_id WHERE membership.tenant_id = $1 GROUP BY membership.id, identity.display_name, identity.email ORDER BY identity.display_name, membership.id",
        [context.tenantId],
      )
      return { data: users.rows }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/users/:id", async (request, reply) => {
    const id = pathId(request.params.id)
    const value = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.read")
      return loadMember(context, id)
    })
    return send(reply, 200, value.revision, value)
  })

  app.put<{ Params: { id: string } }>("/api/v1/users/:id", async (request, reply) => {
    const expected = parseRevision(request.headers["if-match"])
    const id = pathId(request.params.id)
    const value = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.users.manage")
      requirePermission(context, "platform.users.read")
      requirePermission(context, "platform.roles.read")
      const previous = await loadMember(context, id)
      if (BigInt(previous.revision) !== BigInt(expected)) throw stale()
      const parsed = memberSchema.safeParse(request.body)
      if (!parsed.success) throw invalid("JSON inválido ou campos desconhecidos")
      const input = parsed.data
      if (!["active", "blocked", "pending"].includes(input.status) || input.roleIds.length > 128 || new Set(input.roleIds.map(item => item.toLowerCase())).size !== input.roleIds.length) throw invalid("Estado ou papéis inválidos")
      if ((previous.status === "pending") !== (input.status === "pending")) throw conflict("A ativação de convites depende da confirmação no Auth")
      const self = await context.client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM tenant_memberships m JOIN identities i ON i.id = m.identity_id WHERE m.tenant_id = $3 AND m.id = $1 AND i.auth_subject = $2) AS exists", [id, context.authSubject, context.tenantId])
      if (self.rows[0]?.exists && input.status !== "active") throw conflict("Você não pode bloquear o próprio acesso")
      for (const roleId of [...previous.roleIds, ...input.roleIds]) withinAuthority(context, (await loadRole(context, roleId.toLowerCase())).permissions)
      const status = input.status === "active" ? "active" : input.status === "pending" ? "invited" : "disabled"
      await context.client.query("UPDATE tenant_memberships SET status = $3, revision = revision + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2", [context.tenantId, id, status])
      await context.client.query("DELETE FROM membership_roles WHERE membership_id = $1", [id])
      await context.client.query("INSERT INTO membership_roles (membership_id, role_id) SELECT $1, unnest($2::uuid[])", [id, input.roleIds])
      await ensureAdministrator(context)
      const loaded = await loadMember(context, id)
      await record(context, request.headers, "membership", id, "membership.updated", { revision: loaded.revision })
      return loaded
    })
    return send(reply, 200, value.revision, value)
  })

  app.get("/api/v1/roles", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.roles.read")
      const roles = await context.client.query<Record<string, unknown>>(
        "SELECT role.id, role.code, role.name, COALESCE(array_agg(DISTINCT role_permission.permission_code) FILTER (WHERE role_permission.permission_code IS NOT NULL), '{}') AS permissions FROM roles role LEFT JOIN role_permissions role_permission ON role_permission.role_id = role.id WHERE role.tenant_id = $1 GROUP BY role.id, role.code, role.name ORDER BY role.name, role.id",
        [context.tenantId],
      )
      return { data: roles.rows }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/roles/:id", async (request, reply) => {
    const id = pathId(request.params.id)
    const value = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.roles.read")
      return loadRole(context, id)
    })
    return send(reply, 200, value.revision, value)
  })

  app.post("/api/v1/roles", async (request, reply) => {
    const outcome = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.roles.manage")
      requirePermission(context, "platform.roles.read")
      const input = parseRole(request.body)
      withinAuthority(context, input.permissions)
      const rawKey = request.headers["idempotency-key"]
      if (rawKey === undefined) throw new Problem(428, "idempotency_required", "Informe uma chave de idempotência para esta operação")
      const key = typeof rawKey === "string" && z.guid().safeParse(rawKey).success ? rawKey.toLowerCase() : undefined
      if (!key) throw invalid("Chave de idempotência inválida")
      const replay = await context.client.query<{ request: unknown; result: RoleDetail }>("SELECT request, result FROM role_creation_commands WHERE tenant_id = $1 AND auth_subject = $2 AND command_key = $3", [context.tenantId, context.authSubject, key])
      const saved = replay.rows[0]
      if (saved) {
        if (!sameJson(saved.request, input)) throw conflict("Esta chave de idempotência já foi usada com outros dados")
        withinAuthority(context, saved.result.permissions)
        return { value: saved.result, replayed: true }
      }
      const id = randomUUID()
      try {
        await context.client.query("INSERT INTO roles (id, tenant_id, code, name, description) VALUES ($1,$2,$3,$4,$5)", [id, context.tenantId, input.code, input.name, input.description])
      } catch (error) {
        if (uniqueViolation(error)) throw conflict("Já existe um papel com este código nesta empresa")
        throw error
      }
      await replacePermissions(context, id, input.permissions)
      await record(context, request.headers, "role", id, "role.created", { revision: 1 })
      const value = await loadRole(context, id)
      await context.client.query("INSERT INTO role_creation_commands (tenant_id, auth_subject, command_key, request, result) VALUES ($1,$2,$3,$4,$5)", [context.tenantId, context.authSubject, key, input, value])
      return { value, replayed: false }
    })
    if (outcome.replayed) reply.header("idempotency-replayed", "true")
    reply.header("location", `/api/v1/roles/${outcome.value.id}`)
    return send(reply, 201, outcome.value.revision, outcome.value)
  })

  app.put<{ Params: { id: string } }>("/api/v1/roles/:id", async (request, reply) => {
    const expected = parseRevision(request.headers["if-match"])
    const id = pathId(request.params.id)
    const value = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.roles.manage")
      requirePermission(context, "platform.roles.read")
      const previous = await loadRole(context, id)
      if (BigInt(previous.revision) !== BigInt(expected)) throw stale()
      withinAuthority(context, previous.permissions)
      const input = parseRole(request.body)
      withinAuthority(context, input.permissions)
      try {
        await context.client.query("UPDATE roles SET code = $3, name = $4, description = $5, revision = revision + 1 WHERE tenant_id = $1 AND id = $2", [context.tenantId, id, input.code, input.name, input.description])
      } catch (error) {
        if (uniqueViolation(error)) throw conflict("Já existe um papel com este código nesta empresa")
        throw error
      }
      await replacePermissions(context, id, input.permissions)
      await ensureAdministrator(context)
      const loaded = await loadRole(context, id)
      await record(context, request.headers, "role", id, "role.updated", { revision: loaded.revision })
      return loaded
    })
    return send(reply, 200, value.revision, value)
  })

  app.delete<{ Params: { id: string } }>("/api/v1/roles/:id", async (request, reply) => {
    const expected = parseRevision(request.headers["if-match"])
    const id = pathId(request.params.id)
    await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.roles.manage")
      requirePermission(context, "platform.roles.read")
      const previous = await loadRole(context, id)
      if (BigInt(previous.revision) !== BigInt(expected)) throw stale()
      withinAuthority(context, previous.permissions)
      const used = await context.client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM membership_roles WHERE role_id = $1) AS exists", [id])
      if (used.rows[0]?.exists) throw conflict("Este papel está atribuído a usuários. Remova as atribuições antes de excluir")
      await context.client.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [context.tenantId, id])
      await record(context, request.headers, "role", id, "role.deleted", { revision: previous.revision })
    })
    return reply.code(204).header("cache-control", "no-store").send()
  })
}
