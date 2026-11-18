import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { stockFixture } from "./stock-fixture.js"
import { prepareProductionBrowser } from "./production-browser-fixture.js"

const adminUrl = process.env.API_TS_TEST_ADMIN_URL
if (!adminUrl) throw Error("Informe API_TS_TEST_ADMIN_URL para criar o banco descartável de estoque")
const fixture = await stockFixture(adminUrl)
try {
  await fixture.seed.query(`
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'inventory.counts.read' FROM roles;
    INSERT INTO role_permissions(role_id,permission_code)
      SELECT id,unnest(ARRAY['inventory.counts.manage','catalog.categories.read','catalog.categories.manage']) FROM roles WHERE code='editor';
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'inventory.counts.approve' FROM roles WHERE code='visitor'
  `)
  const api = await fixture.app.listen({ host: "127.0.0.1", port: 0 })
  const factory=await prepareProductionBrowser(fixture.seed,fixture.tenant)
  await fixture.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['inventory.periods.close','inventory.periods.reopen']) FROM roles WHERE code='editor'")
  const web = new URL("../../web/", import.meta.url)
  const cli = createRequire(new URL("package.json", web)).resolve("@playwright/test/cli")
  const origin = "http://127.0.0.1:" + (process.env.STOCK_TEST_WEB_PORT || "34242")
  const child = spawn(process.execPath, [cli, "test", "--config", "playwright.stock.config.ts", ...process.argv.slice(2)], {
    cwd: fileURLToPath(web), stdio: "inherit",
    env: { ...process.env, ...factory, ERP_TEST_WEB_ORIGIN: origin, ERP_WEB_ORIGIN: origin, ERP_API_URL: api,
      ERP_TYPESCRIPT_API_URL: api, AUTH_ISSUER: api, ERP_AUTH_CLIENT_ID: "stock-test", ERP_AUTH_CLIENT_SECRET: "stock-test",
      ERP_SESSION_SECRET: "danfe-browser-fixture-not-a-real-service-secret", ERP_DEFAULT_TENANT_ID: fixture.tenant },
  })
  process.exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)) })
} finally { await fixture.close() }
