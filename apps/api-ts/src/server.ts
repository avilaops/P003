import { buildApp } from "./app.js"
import { loadConfiguration } from "./platform/config.js"
import { PostgresPool } from "./platform/database.js"

const configuration = loadConfiguration()
const pool = new PostgresPool(configuration.databaseUrl, configuration.maximumConnections)
const app = buildApp({ pool, userinfoUrl: configuration.userinfoUrl, mcpResource: configuration.mcpResource })
app.addHook("onClose", async () => { await pool.close() })
const shutdown = () => { void app.close().catch(() => { process.exitCode = 1 }) }
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)

try { await app.listen({ host: configuration.host, port: configuration.port }) }
catch (error) { await app.close(); throw error }
