import { defineConfig } from "@playwright/test"
import { secret } from "./playwright.danfe.config"

const common = { ERP_API_URL: "http://127.0.0.1:33311", ERP_TYPESCRIPT_API_URL: "http://127.0.0.1:33312", ERP_FISCAL_API_URL: "", ERP_SESSION_SECRET: secret, AUTH_ISSUER: "http://127.0.0.1:33313", ERP_AUTH_CLIENT_ID: "migration-fixture", ERP_AUTH_CLIENT_SECRET: "migration-fixture-only" }
const runs = [{ name: "typescript", port: 33211, modules: "preferences,registrations,sales,reports" }, { name: "rollback-rust", port: 33212, modules: "" }]
export default defineConfig({
  testDir: "./tests", testMatch: "api-migration-bff.spec.ts", workers: 1, fullyParallel: false, retries: 0,
  timeout: 60000, outputDir: "../../artifacts/api-migration-browser", reporter: "list",
  use: { browserName: "chromium", channel: process.env.ERP_BROWSER_CHANNEL, screenshot: "only-on-failure" },
  projects: runs.map(run => ({ name: run.name, use: { baseURL: `http://127.0.0.1:${run.port}` } })),
  webServer: runs.map(run => ({ command: `pnpm start --hostname 127.0.0.1 --port ${run.port}`, url: `http://127.0.0.1:${run.port}/entrar`, reuseExistingServer: false, timeout: 60000, env: { ...common, ERP_WEB_ORIGIN: `http://127.0.0.1:${run.port}`, ERP_TYPESCRIPT_MODULES: run.modules } })),
  metadata: { scope: "API migration • actual browser and Next BFF selection/rollback", upstream: "controlled local HTTP fixtures", database: "covered separately by shared Rust/TypeScript PostgreSQL contracts" },
})
