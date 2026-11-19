import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { Pool } from "pg"

import { buildApp } from "../src/app.js"
import type { InvitationDelivery } from "../src/modules/invitations/delivery.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

// Convites (porte de invitations.rs). O envio pelo Auth é um stub: nenhum e-mail real sai dos testes.
// `user` administra a empresa A; `denied` só consulta usuários; `outsider` administra apenas a empresa B.
const sent: string[] = []
const delivery: InvitationDelivery = { async send(invitation) { sent.push(invitation.email); return "sent" } }

test("convites", databaseTestOptions, async t => {
  await withTestContext({ dependencies: { invitations: { delivery } } }, async ctx => {
    await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.code='user' AND r.tenant_id=$1 ON CONFLICT DO NOTHING", [ctx.tenant])
    await ctx.grant("denied", "platform.users.read")
    const sales = randomUUID(), foreign = randomUUID()
    await ctx.seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'vendas','Vendas'),($3,$4,'externo','Externo')", [sales, ctx.tenant, foreign, ctx.otherTenant])
    await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read')", [sales])
    const user = ctx.as("user"), denied = ctx.as("denied"), outsider = ctx.as("outsider"), anonymous = ctx.as("anonymous")
    const invite = { name: "Novo Usuário", email: " Novo@Example.Test ", roleIds: [sales], manageUsers: false }
    let invitationId = "", managerId = ""

    await t.test("GET /api/v1/invitations + POST /api/v1/invitations + POST /api/v1/invitations/{id}/resend + POST /api/v1/invitations/{id}/revoke [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      const id = randomUUID()
      for (const [method, url] of [["get", "/api/v1/invitations"], ["post", "/api/v1/invitations"], ["post", `/api/v1/invitations/${id}/resend`], ["post", `/api/v1/invitations/${id}/revoke`]] as const) {
        assert.equal((await anonymous[method](url, { body: invite })).statusCode, 401, url)
        assert.equal((await outsider[method](url, { body: invite })).statusCode, 403, url)
      }
      assert.equal((await denied.post("/api/v1/invitations", { body: invite })).statusCode, 403)
      assert.equal((await denied.post(`/api/v1/invitations/${id}/resend`)).statusCode, 403)
      assert.equal((await denied.post(`/api/v1/invitations/${id}/revoke`)).statusCode, 403)
      assert.equal(sent.length, 0)
    })

    await t.test("POST /api/v1/invitations [sucesso] cria com Idempotency-Key sem reenviar e-mail na repetição", async () => {
      const withoutKey = await ctx.app.inject({ method: "POST", url: "/api/v1/invitations", headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant }, payload: invite })
      assert.equal(withoutKey.statusCode, 428)
      assert.equal((await user.post("/api/v1/invitations", { body: invite, idempotencyKey: "nao" })).statusCode, 422)
      for (const body of [{ ...invite, email: "sem-arroba" }, { ...invite, name: "  " }, { ...invite, roleIds: [] }, { ...invite, extra: true }, { ...invite, roleIds: ["x"] }]) {
        assert.equal((await user.post("/api/v1/invitations", { body })).statusCode, 422, JSON.stringify(body))
      }
      assert.equal((await user.post("/api/v1/invitations", { body: { ...invite, roleIds: [foreign] } })).statusCode, 404, "papel de outra empresa")
      const key = randomUUID()
      const first = await user.post("/api/v1/invitations", { body: invite, idempotencyKey: key })
      assert.equal(first.statusCode, 200, first.body)
      invitationId = first.json().id
      assert.deepEqual([first.json().delivery, first.json().status, first.json().email, first.json().roles], ["sent", "pending", "novo@example.test", ["Vendas"]])
      assert.equal((await user.post("/api/v1/invitations", { body: invite, idempotencyKey: key })).json().id, invitationId)
      assert.equal(sent.length, 1, "repetição idempotente não envia outro e-mail")
      assert.equal((await user.post("/api/v1/invitations", { body: { ...invite, name: "Outro" }, idempotencyKey: key })).statusCode, 409)
      assert.equal((await user.post("/api/v1/invitations", { body: invite })).statusCode, 409, "e-mail já convidado")
      assert.equal((await user.post("/api/v1/invitations", { body: { ...invite, email: "denied@example.test" } })).statusCode, 409, "e-mail já tem acesso")
      const manager = await user.post("/api/v1/invitations", { body: { name: "Gestor", email: "outsider@example.test", roleIds: [], manageUsers: true } })
      assert.equal(manager.statusCode, 200, manager.body)
      assert.deepEqual(manager.json().roles, ["Gestor de usuários"])
      managerId = manager.json().id
    })

    await t.test("GET /api/v1/invitations [sucesso] lista só os convites da empresa", async () => {
      const list = await denied.get("/api/v1/invitations")
      assert.equal(list.statusCode, 200)
      assert.deepEqual([list.json().data.length, list.json().enabled], [2, true])
      assert.equal((await outsider.get("/api/v1/invitations", { tenant: ctx.otherTenant })).json().data.length, 0)
    })

    await t.test("POST /api/v1/invitations/{id}/resend [sucesso] reenvia após um minuto e repete a chave sem novo e-mail", async () => {
      const url = `/api/v1/invitations/${invitationId}/resend`
      assert.equal((await ctx.app.inject({ method: "POST", url, headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant } })).statusCode, 428)
      assert.equal((await user.post(url)).statusCode, 409, "um minuto entre envios")
      assert.equal((await outsider.post(url, { tenant: ctx.otherTenant })).statusCode, 404, "convite de outra empresa")
      await ctx.seed.query("UPDATE user_invitations SET last_delivery_at = now() - interval '2 minutes' WHERE id=$1", [invitationId])
      const key = randomUUID(), before = sent.length
      assert.equal((await user.post(url, { idempotencyKey: key })).statusCode, 200)
      assert.equal((await user.post(url, { idempotencyKey: key })).statusCode, 200)
      assert.equal(sent.length, before + 1, "a mesma chave não reenvia")
    })

    await t.test("POST /api/v1/invitations/{id}/revoke [sucesso] revoga convite pendente e recusa convite aceito", async () => {
      assert.equal((await outsider.post(`/api/v1/invitations/${invitationId}/revoke`, { tenant: ctx.otherTenant })).statusCode, 404)
      const revoked = await user.post(`/api/v1/invitations/${invitationId}/revoke`)
      assert.equal(revoked.json().status, "revoked")
      assert.equal((await user.post(`/api/v1/invitations/${invitationId}/resend`)).statusCode, 409, "revogado não é reenviado")
      assert.equal((await user.post(`/api/v1/invitations/${randomUUID()}/revoke`)).statusCode, 404)
    })

    await t.test("GET /api/v1/companies [sucesso] aceita o convite do e-mail verificado e concede os papéis", async () => {
      // App com Auth que confirma o e-mail: o mesmo banco e a mesma role sem privilégios do contexto.
      const url = new URL(process.env.API_TS_TEST_ADMIN_URL!); url.pathname = `/${ctx.database}`
      const runtime = new Pool({ connectionString: url.href })
      const verified = buildApp({ userinfoUrl: "http://auth.test/userinfo", fetchAuth: async (_url, init) => {
        const sub = new Headers(init?.headers).get("authorization")!.slice(7)
        return Response.json({ sub, email: `${sub}@example.test`, email_verified: true })
      }, pool: { async connect() { const client = await runtime.connect(); await client.query(`SET ROLE ${ctx.role}`); return new PgClientAdapter(client) } } })
      try {
        assert.equal((await outsider.get("/api/v1/users")).statusCode, 403, "antes do aceite não pertence à empresa A")
        const companies = await verified.inject({ method: "GET", url: "/api/v1/companies", headers: { authorization: "Bearer outsider" } })
        assert.equal(companies.statusCode, 200, companies.body)
        assert.deepEqual(companies.json().data.map((item: { id: string }) => item.id).sort(), [ctx.tenant, ctx.otherTenant].sort())
        assert.equal((await outsider.get("/api/v1/users")).statusCode, 200, "o papel Gestor de usuários foi concedido")
        const state = await ctx.seed.query("SELECT status,accepted_subject FROM user_invitations WHERE id=$1", [managerId])
        assert.deepEqual(state.rows[0], { status: "accepted", accepted_subject: "outsider" })
        assert.equal((await user.post(`/api/v1/invitations/${managerId}/revoke`)).statusCode, 409, "convite aceito não é revogado")
        assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='user_invitation.accepted'")).rows[0].n, 1)
      } finally { await verified.close(); await runtime.end() }
    })

    await t.test("POST /api/v1/invitations [negado] envio não configurado responde 409", async () => {
      const app = buildApp({ pool: { async connect() { throw Error("sem banco") } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "user", email: "user@example.test" }), invitations: { delivery: null } })
      try {
        const response = await app.inject({ method: "POST", url: "/api/v1/invitations", headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant, "idempotency-key": randomUUID() }, payload: invite })
        assert.equal(response.statusCode, 409)
      } finally { await app.close() }
    })
  })
})
