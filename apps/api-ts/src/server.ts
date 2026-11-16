import { buildApp } from "./app.js"
import { loadConfiguration } from "./platform/config.js"
import { PostgresPool } from "./platform/database.js"

const configuration = loadConfiguration()
const pool = new PostgresPool(configuration.databaseUrl, configuration.maximumConnections)
const app = buildApp({ pool, userinfoUrl: configuration.userinfoUrl })

await app.listen({ host: configuration.host, port: configuration.port })
