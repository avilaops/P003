import { z } from "zod"

const configSchema = z.object({
  DATABASE_URL: z.string().url(),
  AUTH_ISSUER: z.string().url(),
  API_TS_HOST: z.string().default("127.0.0.1"),
  API_TS_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(20).default(5),
})

export type Configuration = {
  databaseUrl: string
  userinfoUrl: string
  host: string
  port: number
  maximumConnections: number
}

export function loadConfiguration(environment: NodeJS.ProcessEnv = process.env): Configuration {
  const value = configSchema.parse(environment)
  return {
    databaseUrl: value.DATABASE_URL,
    userinfoUrl: new URL("oauth/userinfo", value.AUTH_ISSUER.endsWith("/") ? value.AUTH_ISSUER : `${value.AUTH_ISSUER}/`).toString(),
    host: value.API_TS_HOST,
    port: value.API_TS_PORT,
    maximumConnections: value.DATABASE_MAX_CONNECTIONS,
  }
}
