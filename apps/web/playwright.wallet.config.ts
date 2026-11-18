import { defineConfig } from "@playwright/test"
import base, { secret } from "./playwright.danfe.config"

const origin = (process.env.ERP_TEST_WEB_ORIGIN = "http://127.0.0.1:33384")
const port = (process.env.WALLET_TEST_API_PORT = "33385")
export default defineConfig({
  ...base,
  testMatch: ["order-finance-ui.spec.ts", "purchase-ui.spec.ts"],
  use: { ...base.use, baseURL: origin },
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 33384",
    url: origin + "/entrar",
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      ERP_NEXT_DIST_DIR: ".next-wallet-tests",
      ERP_WEB_ORIGIN: origin,
      ERP_API_URL: "http://127.0.0.1:" + port,
      ERP_TYPESCRIPT_API_URL: "http://127.0.0.1:" + port,
      ERP_SESSION_SECRET: secret,
      AUTH_ISSUER: "http://127.0.0.1:33386",
      ERP_DEFAULT_TENANT_ID: "99999999-9999-4999-8999-999999999999",
      ERP_AUTH_CLIENT_ID: "wallet-test",
      ERP_AUTH_CLIENT_SECRET: "wallet-test",
    },
  },
})
