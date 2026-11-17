import { defineConfig } from "@playwright/test"
import base from "./playwright.danfe.config"

const origin = "http://127.0.0.1:33190"
process.env.ERP_TEST_API_PORT = "33191"
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer
if (!server) throw new Error("Commercial document tests require the base web server")

export default defineConfig({
  ...base,
  metadata: { ...base.metadata, scope: "Commercial document downloads and central SMTP" },
  testMatch: ["platform-mail-ui.spec.ts", "order-document-ui.spec.ts", "order-email-ui.spec.ts", "finance-email-bff.spec.ts", "finance-email-ui.spec.ts", "mixed-order-bff.spec.ts"],
  use: { ...base.use, baseURL: origin, browserName: "chromium" },
  webServer: {
    ...server,
    command: process.env.ERP_BROWSER_DEV === "1" ? "pnpm dev --hostname 127.0.0.1 --port 33190" : "pnpm start --hostname 127.0.0.1 --port 33190",
    url: `${origin}/entrar`,
    env: { ...server.env, ERP_WEB_ORIGIN: origin, ERP_API_URL: "http://127.0.0.1:33191", ERP_TYPESCRIPT_API_URL: "http://127.0.0.1:33191" },
  },
})
