import { z } from "zod"

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_ISSUER: z.string().url(),
  AUTH_USERINFO_URL: z.string().url().optional(),
  ERP_MCP_ORIGIN: z.string().url().default("https://erp.avilaops.com"),
  API_TS_HOST: z.string().default("127.0.0.1"),
  API_TS_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(20).default(5),
  ERP_FISCAL_ENGINE_URL: z.string().url().optional(),
  ERP_FISCAL_ENGINE_TOKEN: z.string().min(24).optional(),
  FISCAL_A1_KEYRING: z.string().optional(),
})

export type Configuration = {
  databaseUrl: string
  userinfoUrl: string
  host: string
  port: number
  maximumConnections: number
  mcpResource: string
  fiscalEngine?: { url: string; token: string; keyring: string }
}

export function loadConfiguration(environment: NodeJS.ProcessEnv = process.env): Configuration {
  const value = configSchema.parse(environment)
  const issuer = new URL(value.AUTH_ISSUER)
  const userinfo = new URL(value.AUTH_USERINFO_URL ?? "oauth/userinfo", value.AUTH_ISSUER.endsWith("/") ? value.AUTH_ISSUER : `${value.AUTH_ISSUER}/`)
  if (userinfo.origin !== issuer.origin || userinfo.username || userinfo.password || userinfo.hash) throw Error("Invalid userinfo origin")
  const mcpOrigin = new URL(value.ERP_MCP_ORIGIN)
  if (mcpOrigin.username || mcpOrigin.password || mcpOrigin.pathname !== "/" || mcpOrigin.search || mcpOrigin.hash || mcpOrigin.protocol !== "https:" && !(mcpOrigin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(mcpOrigin.hostname))) throw Error("Invalid MCP origin")
  const fiscalValues = [value.ERP_FISCAL_ENGINE_URL, value.ERP_FISCAL_ENGINE_TOKEN, value.FISCAL_A1_KEYRING]
  if (fiscalValues.some(Boolean) && !fiscalValues.every(Boolean)) throw Error("Incomplete fiscal engine configuration")
  const fiscalUrl = value.ERP_FISCAL_ENGINE_URL ? new URL(value.ERP_FISCAL_ENGINE_URL) : undefined
  if (fiscalUrl && (fiscalUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(fiscalUrl.hostname) || fiscalUrl.username || fiscalUrl.password || fiscalUrl.pathname !== "/" || fiscalUrl.search || fiscalUrl.hash)) throw Error("Fiscal engine must use a loopback HTTP origin")
  return {
    databaseUrl: value.DATABASE_URL,
    userinfoUrl: userinfo.toString(),
    host: value.API_TS_HOST,
    port: value.API_TS_PORT,
    maximumConnections: value.DATABASE_MAX_CONNECTIONS,
    mcpResource: `${mcpOrigin.origin}/mcp`,
    ...(fiscalUrl && value.ERP_FISCAL_ENGINE_TOKEN && value.FISCAL_A1_KEYRING ? { fiscalEngine: { url: fiscalUrl.origin, token: value.ERP_FISCAL_ENGINE_TOKEN, keyring: value.FISCAL_A1_KEYRING } } : {}),
  }
}
