import { startPayrollWorker } from "./modules/finance-wallets/payroll.js"
import { buildApp } from "./app.js"
import { startCostWorker } from "./modules/inventory/cost-jobs.js"
import { loadConfiguration } from "./platform/config.js"
import { PostgresPool } from "./platform/database.js"
import { FiscalCertificateVault } from "./modules/outgoing-nfse/certificate-vault.js"
import { HttpOutgoingNfseEngine } from "./modules/outgoing-nfse/engine-client.js"
import { createBrowserUseRuns } from "./platform/browser-use.js"

const configuration = loadConfiguration()
const pool = new PostgresPool(configuration.databaseUrl, configuration.maximumConnections)
const outgoingNfse = configuration.fiscalEngine ? (() => {
  const vault = new FiscalCertificateVault(configuration.fiscalEngine.keyring)
  return { engine: new HttpOutgoingNfseEngine(configuration.fiscalEngine.url, configuration.fiscalEngine.token), certificateProvider: vault.material.bind(vault), automaticEnabled: configuration.fiscalEngine.automaticEnabled }
})() : undefined
const browserUse = configuration.browserUseApiKey ? { runs: createBrowserUseRuns(configuration.browserUseApiKey) } : undefined
const app = buildApp({ pool, userinfoUrl: configuration.userinfoUrl, mcpResource: configuration.mcpResource, ...(outgoingNfse ? { outgoingNfse } : {}), ...(browserUse ? { browserUse } : {}) })
const workers = process.env.ERP_BACKGROUND_WORKERS_ENABLED ?? "true"
if (workers !== "false" && workers !== "true") throw new Error("ERP_BACKGROUND_WORKERS_ENABLED must be true or false")
const stopCostWorker = workers === "true" ? startCostWorker(pool) : undefined
app.addHook("onClose", async () => {
  await stopCostWorker?.()
  await pool.close()
})
if (workers === "true") startPayrollWorker(app, pool)
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1 }) }
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)

try { await app.listen({ host: configuration.host, port: configuration.port }) }
catch (error) { await app.close(); throw error }
