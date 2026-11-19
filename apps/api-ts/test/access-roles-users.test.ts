import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

// Papéis e membros (porte de access.rs / access_management.rs).
// Personas do helper: `user` administra a empresa A (todas as permissões); `denied` só consulta usuários, papéis e empresa;
// `outsider` administra apenas a empresa B; `anonymous` não envia token.
const READ = ["platform.users.read", "platform.roles.read", "platform.company.read"]

async function setup(ctx: TestContext) {
  // Mesmo privilégio da produção (deploy/bootstrap.sql): a role da aplicação também exclui.
  await ctx.seed.query(`GRANT DELETE ON ALL TABLES IN SCHEMA public TO ${ctx.role}`)
  await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.code='user' AND r.tenant_id=$1 ON CONFLICT DO NOTHING", [ctx.tenant])
  await ctx.grant("denied", ...READ)
  const ids = await ctx.seed.query<{ code: string; role: string; membership: string }>("SELECT r.code,r.id AS role,m.id AS membership FROM roles r JOIN membership_roles mr ON mr.role_id=r.id JOIN tenant_memberships m ON m.id=mr.membership_id")
  const by = Object.fromEntries(ids.rows.map(row => [row.code, row]))
  return { userRole: by.user!.role, deniedRole: by.denied!.role, foreignRole: by.outsider!.role, userMembership: by.user!.membership, deniedMembership: by.denied!.membership, foreignMembership: by.outsider!.membership }
}

test("papéis e usuários", databaseTestOptions, async t => {
  await withTestContext({}, async ctx => {
    const ids = await setup(ctx)
    const user = ctx.as("user"), denied = ctx.as("denied"), outsider = ctx.as("outsider"), anonymous = ctx.as("anonymous")
    const roleInput = { code: "comercial", name: " Consulta comercial ", description: "Papel de teste", permissions: ["platform.company.read"] }
    let roleId = ""

    await t.test("GET /api/v1/roles + POST /api/v1/roles + GET /api/v1/roles/{id} + PUT /api/v1/roles/{id} + DELETE /api/v1/roles/{id} [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      for (const [method, path] of [["get", "/api/v1/roles"], ["post", "/api/v1/roles"], ["get", `/api/v1/roles/${ids.deniedRole}`], ["put", `/api/v1/roles/${ids.deniedRole}`], ["delete", `/api/v1/roles/${ids.deniedRole}`]] as const) {
        assert.equal((await anonymous[method](path, { body: roleInput, revision: 1 })).statusCode, 401, path)
        assert.equal((await outsider[method](path, { body: roleInput, revision: 1 })).statusCode, 403, `${method} ${path}: membro só da outra empresa`)
      }
      assert.equal((await denied.post("/api/v1/roles", { body: roleInput })).statusCode, 403)
      assert.equal((await denied.put(`/api/v1/roles/${ids.deniedRole}`, { body: roleInput, revision: 1 })).statusCode, 403)
      assert.equal((await denied.delete(`/api/v1/roles/${ids.deniedRole}`, { revision: 1 })).statusCode, 403)
      assert.equal((await user.get("/api/v1/roles", { headers: { "x-tenant-id": "nao-e-uuid" } })).statusCode, 400)
      // Teto de autoridade: ninguém concede o que não possui.
      assert.equal((await outsider.post("/api/v1/roles", { tenant: ctx.otherTenant, body: { ...roleInput, permissions: ["platform.company.read"] } })).statusCode, 201)
    })

    await t.test("POST /api/v1/roles [sucesso] cria com Idempotency-Key, repete a mesma intenção e recusa conflito", async () => {
      const withoutKey = await ctx.app.inject({ method: "POST", url: "/api/v1/roles", headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant }, payload: roleInput })
      assert.equal(withoutKey.statusCode, 428)
      assert.equal((await user.post("/api/v1/roles", { body: roleInput, idempotencyKey: "x" })).statusCode, 422)
      for (const body of [{ ...roleInput, code: "Inválido" }, { ...roleInput, name: "  " }, { ...roleInput, extra: 1 }, { ...roleInput, permissions: ["platform.company.read", "platform.company.read"] }, { ...roleInput, permissions: ["platform.company.manage"] }]) {
        assert.equal((await user.post("/api/v1/roles", { body })).statusCode, 422, JSON.stringify(body))
      }
      assert.equal((await user.post("/api/v1/roles", { body: { ...roleInput, permissions: ["nao.existe"] } })).statusCode, 403, "fora da autoridade de quem concede")
      const key = randomUUID()
      const created = await user.post("/api/v1/roles", { body: roleInput, idempotencyKey: key })
      assert.equal(created.statusCode, 201, created.body)
      assert.equal(created.headers.etag, '"1"')
      roleId = created.json().id
      assert.equal(created.headers.location, `/api/v1/roles/${roleId}`)
      assert.deepEqual(created.json(), { id: roleId, code: "comercial", name: "Consulta comercial", description: "Papel de teste", revision: 1, permissions: ["platform.company.read"] })
      const replay = await user.post("/api/v1/roles", { body: roleInput, idempotencyKey: key })
      assert.equal(replay.statusCode, 201)
      assert.equal(replay.headers["idempotency-replayed"], "true")
      assert.deepEqual(replay.json(), created.json())
      assert.equal((await user.post("/api/v1/roles", { body: { ...roleInput, code: "outro" }, idempotencyKey: key })).statusCode, 409, "mesma chave, outra intenção")
      assert.equal((await user.post("/api/v1/roles", { body: roleInput })).statusCode, 409, "código repetido")
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM roles WHERE tenant_id=$1 AND code='comercial'", [ctx.tenant])).rows[0].n, 1)
    })

    await t.test("GET /api/v1/roles + GET /api/v1/roles/{id} [sucesso] lista e detalha só os papéis da empresa", async () => {
      const list = await denied.get("/api/v1/roles")
      assert.equal(list.statusCode, 200)
      assert.deepEqual(list.json().data.map((role: { code: string }) => role.code).sort(), ["comercial", "denied", "user"])
      assert.ok(!list.body.includes(ids.foreignRole), "papel de outra empresa invisível")
      const detail = await denied.get(`/api/v1/roles/${roleId}`)
      assert.equal(detail.statusCode, 200)
      assert.equal(detail.headers.etag, '"1"')
      assert.equal((await user.get(`/api/v1/roles/${ids.foreignRole}`)).statusCode, 404, "papel de outra empresa")
      assert.equal((await user.get("/api/v1/roles/nao-e-uuid")).statusCode, 400)
    })

    await t.test("PUT /api/v1/roles/{id} [sucesso] altera com If-Match, recusa revisão antiga e protege o último administrador", async () => {
      const path = `/api/v1/roles/${roleId}`
      assert.equal((await user.put(path, { body: roleInput })).statusCode, 428)
      assert.equal((await user.put(path, { body: roleInput, headers: { "if-match": "1" } })).statusCode, 400)
      assert.equal((await user.put(path, { body: roleInput, revision: 9 })).statusCode, 412)
      assert.equal((await user.put(path, { body: { ...roleInput, code: "BAD" }, revision: 1 })).statusCode, 422)
      assert.equal((await user.put(`/api/v1/roles/${ids.foreignRole}`, { body: roleInput, revision: 1 })).statusCode, 404)
      const updated = await user.put(path, { body: { ...roleInput, name: "Comercial", permissions: ["platform.company.read", "platform.users.read"] }, revision: 1 })
      assert.equal(updated.statusCode, 200, updated.body)
      assert.equal(updated.headers.etag, '"2"')
      assert.deepEqual(updated.json().permissions, ["platform.company.read", "platform.users.read"])
      assert.equal((await user.put(path, { body: roleInput, revision: 1 })).statusCode, 412, "revisão já consumida")
      const evidence = await ctx.seed.query("SELECT (SELECT array_agg(action ORDER BY action) FROM audit_log WHERE entity_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS events", [roleId])
      assert.deepEqual(evidence.rows[0], { audits: ["role.created", "role.updated"], events: 2 })
      const stripped = await user.put(`/api/v1/roles/${ids.userRole}`, { body: { code: "user", name: "Usuário", description: "", permissions: READ }, revision: 1 })
      assert.equal(stripped.statusCode, 409, "a empresa perderia o único administrador")
    })

    await t.test("DELETE /api/v1/roles/{id} [sucesso] exclui com If-Match e recusa papel em uso", async () => {
      assert.equal((await user.delete(`/api/v1/roles/${roleId}`)).statusCode, 428)
      assert.equal((await user.delete(`/api/v1/roles/${ids.deniedRole}`, { revision: 1 })).statusCode, 409, "papel em uso")
      assert.equal((await user.delete(`/api/v1/roles/${roleId}`, { revision: 1 })).statusCode, 412)
      assert.equal((await user.delete(`/api/v1/roles/${ids.foreignRole}`, { revision: 1 })).statusCode, 404)
      assert.equal((await user.delete(`/api/v1/roles/${roleId}`, { revision: 2 })).statusCode, 204)
      assert.equal((await user.get(`/api/v1/roles/${roleId}`)).statusCode, 404)
    })

    await t.test("GET /api/v1/users + GET /api/v1/users/{id} + PUT /api/v1/users/{id} [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      const path = `/api/v1/users/${ids.deniedMembership}`, body = { status: "active", roleIds: [ids.deniedRole] }
      for (const [method, url] of [["get", "/api/v1/users"], ["get", path], ["put", path]] as const) {
        assert.equal((await anonymous[method](url, { body, revision: 1 })).statusCode, 401)
        assert.equal((await outsider[method](url, { body, revision: 1 })).statusCode, 403)
      }
      assert.equal((await denied.put(path, { body, revision: 1 })).statusCode, 403)
      assert.equal((await outsider.get(`/api/v1/users/${ids.deniedMembership}`, { tenant: ctx.otherTenant })).statusCode, 404, "membro de outra empresa")
    })

    await t.test("GET /api/v1/users + GET /api/v1/users/{id} [sucesso] lista e detalha membros da empresa", async () => {
      const users = await denied.get("/api/v1/users")
      assert.equal(users.statusCode, 200)
      assert.deepEqual(users.json().data.map((item: { name: string; status: string }) => [item.name, item.status]).sort(), [["Sem permissão", "active"], ["Usuário de teste", "active"]])
      const detail = await denied.get(`/api/v1/users/${ids.deniedMembership}`)
      assert.equal(detail.statusCode, 200)
      assert.equal(detail.headers.etag, '"1"')
      assert.deepEqual(detail.json(), { id: ids.deniedMembership, name: "Sem permissão", email: "denied@example.test", status: "active", revision: 1, roleIds: [ids.deniedRole] })
      assert.equal((await user.get(`/api/v1/users/${ids.foreignMembership}`)).statusCode, 404)
    })

    await t.test("PUT /api/v1/users/{id} [sucesso] bloqueia membro com If-Match e protege o próprio acesso e o último administrador", async () => {
      const path = `/api/v1/users/${ids.deniedMembership}`
      assert.equal((await user.put(path, { body: { status: "active", roleIds: [ids.deniedRole] } })).statusCode, 428)
      assert.equal((await user.put(path, { body: { status: "active", roleIds: [ids.deniedRole] }, revision: 4 })).statusCode, 412)
      for (const body of [{ status: "deleted", roleIds: [] }, { status: "active", roleIds: [ids.deniedRole, ids.deniedRole] }, { status: "active" }, { status: "active", roleIds: [], x: 1 }]) {
        assert.equal((await user.put(path, { body, revision: 1 })).statusCode, 422, JSON.stringify(body))
      }
      assert.equal((await user.put(path, { body: { status: "active", roleIds: [ids.foreignRole] }, revision: 1 })).statusCode, 404, "papel de outra empresa")
      assert.equal((await user.put(`/api/v1/users/${ids.userMembership}`, { body: { status: "blocked", roleIds: [ids.userRole] }, revision: 1 })).statusCode, 409, "bloquear a si mesmo")
      assert.equal((await user.put(`/api/v1/users/${ids.userMembership}`, { body: { status: "active", roleIds: [ids.deniedRole] }, revision: 1 })).statusCode, 409, "último administrador")
      const blocked = await user.put(path, { body: { status: "blocked", roleIds: [ids.deniedRole] }, revision: 1 })
      assert.equal(blocked.statusCode, 200, blocked.body)
      assert.equal(blocked.json().status, "blocked")
      assert.equal(blocked.headers.etag, '"2"')
      assert.equal((await denied.get("/api/v1/roles")).statusCode, 403, "membro bloqueado perde o acesso")
      assert.equal((await user.put(path, { body: { status: "active", roleIds: [ids.deniedRole] }, revision: 1 })).statusCode, 412)
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='membership.updated' AND entity_id=$1", [ids.deniedMembership])).rows[0].n, 1)
      await ctx.seed.query("UPDATE tenant_memberships SET status='invited' WHERE id=$1", [ids.deniedMembership])
      assert.equal((await user.put(path, { body: { status: "active", roleIds: [ids.deniedRole] }, revision: 2 })).statusCode, 409, "convite pendente depende do Auth")
    })
  })
})
