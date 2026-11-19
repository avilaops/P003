import { Pool } from "pg"
import { PgClientAdapter } from "../src/platform/database.js"
import type { TestContext } from "./support/test-context.js"

// Em produção o GRANT vai para `erp_next_app` (migração); aqui o papel de teste recebe o mesmo direito.
// Pool próprio: `SET ROLE` não pode vazar para a conexão de preparação (`ctx.seed`).
export function runtimePool(ctx: TestContext) {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!); url.pathname = "/" + ctx.database
  const pool = new Pool({ connectionString: url.href, max: 3 })
  return { async connect() {
    const client = await pool.connect()
    await client.query(`SET ROLE ${ctx.role}`)
    await ctx.seed.query(`GRANT EXECUTE ON FUNCTION erp_service_billing_due_tenants(date) TO ${ctx.role}`)
    const adapter = new PgClientAdapter(client)
    adapter.release = () => client.release(true)
    return adapter
  } }
}
