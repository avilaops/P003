import { defineConfig } from "@playwright/test"

const origin = process.env.ERP_TEST_WEB_ORIGIN || "http://127.0.0.1:34242"

export default defineConfig({
  testDir: "./tests",
  testMatch: ["stock-persistence.spec.ts", "inventory-counts-ui.spec.ts", "catalog-navigation-ui.spec.ts", "frontend-states-ui.spec.ts", "supply-ui.spec.ts", "stock-production-ui.spec.ts"],
  grep: /estoque|resposta perdida|supply-ui\.spec/iu,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "../../artifacts/stock-browser",
  reporter: "list",
  use: { baseURL: origin, browserName: "chromium", channel: process.env.ERP_BROWSER_CHANNEL, screenshot: "only-on-failure" },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port ${new URL(origin).port}`,
    url: origin + "/entrar", timeout: 180_000,
  },
})
