import { defineConfig } from "@playwright/test"
import base from "./playwright.danfe.config"

const port = Number(process.env.ERP_TREASURY_BROWSER_PORT ?? 33247)
const origin = "http://127.0.0.1:" + port
const production = process.env.ERP_FINANCE_BROWSER_PRODUCTION === "1"
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer
export default defineConfig({
  ...base,
  testMatch: ["finance-treasury-ui.spec.ts", "finance-treasury-persistence.spec.ts", "finance-insights-ui.spec.ts", "finance-management-ui.spec.ts"],
  workers: 1,
  timeout: 180_000,
  use: { ...base.use, baseURL: origin },
  webServer: {
    ...server,
    command: "pnpm exec next " + (production ? "start" : "dev --webpack") + " --hostname 127.0.0.1 --port " + port,
    url: origin + "/banks/asaas-ip-s-a.svg",
    timeout: 240_000,
    env: {
      ...server?.env,
      ERP_WEB_ORIGIN: origin,
      ERP_NEXT_DIST_DIR: production ? ".next" : port === 33247 ? ".next-treasury-tests" : ".next-treasury-tests-" + port,
      // No legacy server runs at this origin. Treasury and its session check must use the TypeScript API.
      ERP_API_URL: "http://127.0.0.1:" + (port + 1),
      ERP_TYPESCRIPT_API_URL: "http://127.0.0.1:" + (port + 2),
    },
  },
})
