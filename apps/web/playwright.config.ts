import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testIgnore: ["help-ui.spec.ts", "dashboard-preferences.spec.ts", "pending-work-ui.spec.ts", "company-persistence.spec.ts", "access-persistence.spec.ts", "catalog-persistence.spec.ts", "stock-persistence.spec.ts", "inventory-counts-ui.spec.ts", "stock-costs-ui.spec.ts", "stock-production-ui.spec.ts", "stock-reports-ui.spec.ts", "party-persistence.spec.ts", "operations-persistence.spec.ts", "reference-persistence.spec.ts", "danfe-ui.spec.ts", "proposals-ui.spec.ts", "proposals-persistence.spec.ts"],
  fullyParallel: true,
  workers: 5,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3201",
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium", viewport: { width: 1024, height: 900 } } }],
  webServer: {
    command: "pnpm start --port 3201",
    url: "http://127.0.0.1:3201",
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
