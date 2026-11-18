import { buildApp } from "./app.js"
import { fiscalTransport } from "./modules/fiscal-workspace/engine.js"
import { startCostWorker } from "./modules/inventory/cost-jobs.js"
import { loadConfiguration } from "./platform/config.js"
import { PostgresPool } from "./platform/database.js"
import { FiscalCertificateVault } from "./modules/outgoing-nfse/certificate-vault.js"
import { HttpOutgoingNfseEngine } from "./modules/outgoing-nfse/engine-client.js"

const configuration = loadConfiguration()
const pool = new PostgresPool(configuration.databaseUrl, configuration.maximumConnections)
const vault=configuration.fiscalEngine ? new FiscalCertificateVault(configuration.fiscalEngine.keyring) : undefined
const outgoingNfse = configuration.fiscalEngine && vault ? (() => {
  return { engine: new HttpOutgoingNfseEngine(configuration.fiscalEngine.url, configuration.fiscalEngine.token), certificateProvider: vault.material.bind(vault), automaticEnabled: configuration.fiscalEngine.automaticEnabled }
})() : undefined
const fiscalOperations=configuration.fiscalEngine && vault ? {call:fiscalTransport(configuration.fiscalEngine.url,configuration.fiscalEngine.token),material:vault.material.bind(vault),nfceSecret:vault.nfceSecret.bind(vault),productionRecipient:(tenant:string)=>process.env.SEFAZ_MONITOR_ENABLED==="true" && (!process.env.SEFAZ_MONITOR_TENANT_ID || process.env.SEFAZ_MONITOR_TENANT_ID.toLowerCase()===tenant),production:(tenant:string)=>process.env.NFE_PRODUCTION_ENABLED==="true" && process.env.NFE_PRODUCTION_TENANT_ID?.toLowerCase()===tenant} : undefined
const app = buildApp({ ...(vault?{fiscalVault:vault}:{}), ...(fiscalOperations ? {fiscalOperations}:{}), pool, userinfoUrl: configuration.userinfoUrl, mcpResource: configuration.mcpResource, ...(outgoingNfse ? { outgoingNfse } : {}) })
const stopCostWorker = startCostWorker(pool)
app.addHook("onClose", async () => { await stopCostWorker(); await pool.close() })
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1 }) }
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)

try { await app.listen({ host: configuration.host, port: configuration.port }) }
catch (error) { await app.close(); throw error }
