import assert from "node:assert/strict"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import type { Pool } from "pg"

export async function verifySimulationPermissionReload(app: FastifyInstance, seed: Pool, tenant: string, url: string, payload: object) {
  const role = (await seed.query("SELECT mr.role_id FROM membership_roles mr JOIN tenant_memberships m ON m.id=mr.membership_id JOIN identities i ON i.id=m.identity_id WHERE m.tenant_id=$1 AND i.auth_subject='commercial-manager'", [tenant])).rows[0].role_id
  const privileges = ["platform.company.manage", "sales.approvals.director"]
  const original = (await seed.query("SELECT permission_code FROM role_permissions WHERE role_id=$1 AND permission_code=ANY($2::text[])", [role, privileges])).rows.map(row => row.permission_code)
  const simulate = () => app.inject({ method: "POST", url, headers: { authorization: "Bearer commercial-manager", "x-tenant-id": tenant }, payload })
  try {
    for (const revoked of privileges) {
      for (const permission of privileges) await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING", [role, permission])
      const before = await simulate()
      assert.equal(before.statusCode, 200, before.body)
      assert.ok(before.json().director)
      const locked = await seed.connect()
      let pending: Promise<LightMyRequestResponse> | undefined
      try {
        await locked.query("BEGIN")
        await locked.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenant])
        pending = Promise.resolve(simulate())
        const deadline = Date.now() + 5000
        let waiting = false
        while (Date.now() < deadline) {
          waiting = (await seed.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM tenants WHERE id=$1 FOR SHARE') AS waiting")).rows[0].waiting
          if (waiting) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.ok(waiting, "The simulation must be waiting on the real tenant lock")
        await locked.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=$2", [role, revoked])
        await locked.query("COMMIT")
        const after = await pending
        assert.equal(after.statusCode, 200, after.body)
        assert.equal(after.json().director, null, `${url} must conceal margins after ${revoked} is revoked while waiting`)
        assert.deepEqual(after.json().sale, before.json().sale)
      } finally {
        await locked.query("ROLLBACK"); locked.release()
        if (pending) await pending
      }
    }
  } finally {
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=ANY($2::text[])", [role, privileges])
    for (const permission of original) await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)", [role, permission])
  }
}
