import { defineConfig } from "@playwright/test"
import base from "./playwright.danfe.config"

const origin = "http://127.0.0.1:33247"
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer
export default defineConfig({
  ...base,
  testMatch: ["finance-treasury-ui.spec.ts"],
  workers: 1,
  timeout: 180_000,
  use: { ...base.use, baseURL: origin },
  webServer: {
    ...server,
    command: "pnpm exec next dev --webpack --hostname 127.0.0.1 --port 33247",
    url: origin + "/banks/asaas-ip-s-a.svg",
    timeout: 240_000,
    env: { ...server?.env, ERP_WEB_ORIGIN: origin, ERP_NEXT_DIST_DIR: ".next-treasury-tests" },
  },
})
