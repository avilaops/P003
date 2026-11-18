import { startPayrollWorker } from "./modules/finance-wallets/payroll.js"
import { buildApp } from "./app.js"
import { loadConfiguration } from "./platform/config.js"
import { PostgresPool } from "./platform/database.js"
import { FiscalCertificateVault } from "./modules/outgoing-nfse/certificate-vault.js"
import { HttpOutgoingNfseEngine } from "./modules/outgoing-nfse/engine-client.js"

const configuration = loadConfiguration()
const pool = new PostgresPool(configuration.databaseUrl, configuration.maximumConnections)
const outgoingNfse = configuration.fiscalEngine ? (() => {
  const vault = new FiscalCertificateVault(configuration.fiscalEngine.keyring)
  return { engine: new HttpOutgoingNfseEngine(configuration.fiscalEngine.url, configuration.fiscalEngine.token), certificateProvider: vault.material.bind(vault), automaticEnabled: configuration.fiscalEngine.automaticEnabled }
})() : undefined
const app = buildApp({ pool, userinfoUrl: configuration.userinfoUrl, mcpResource: configuration.mcpResource, ...(outgoingNfse ? { outgoingNfse } : {}) })
app.addHook("onClose", async () => { await pool.close() })
const workers = process.env.ERP_BACKGROUND_WORKERS_ENABLED ?? "true"
if (workers !== "false" && workers !== "true") throw new Error("ERP_BACKGROUND_WORKERS_ENABLED must be true or false")
if (workers === "true") startPayrollWorker(app, pool)
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1 }) }
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)

try { await app.listen({ host: configuration.host, port: configuration.port }) }
catch (error) { await app.close(); throw error }
