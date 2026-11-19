// Private media origin (the catalogue site). Injected in tests; the default reads the same
// environment variables as the Rust API: CATALOG_MEDIA_ORIGIN, CATALOG_MEDIA_TOKEN, CATALOG_MEDIA_TENANT.
export interface CatalogMediaGateway {
  readonly tenant: string
  /** Reads a private object by its key under ludus/catalogo/; rejects when unavailable or above the limit. */
  readPrivate(key: string, maximumBytes: number): Promise<Buffer>
}

let cached: { signature: string; gateway: CatalogMediaGateway | undefined } | undefined

export function catalogMediaFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CatalogMediaGateway | undefined {
  const { CATALOG_MEDIA_ORIGIN: origin, CATALOG_MEDIA_TOKEN: token, CATALOG_MEDIA_TENANT: tenant } = environment
  const signature = `${origin}\0${token}\0${tenant}`
  if (cached?.signature === signature) return cached.gateway
  let gateway: CatalogMediaGateway | undefined
  if (origin && token && tenant) {
    const url = new URL(origin)
    if (url.protocol !== "https:" || url.hostname !== "ludusequipamentos.com" || url.pathname !== "/" || token.length < 32) throw new Error("Invalid catalog media configuration")
    const base = origin.replace(/\/$/, "")
    gateway = {
      tenant: tenant.toLowerCase(),
      async readPrivate(key, maximumBytes) {
        const reply = await fetch(`${base}/midias/_private/${key}`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(20_000) })
        const length = Number(reply.headers.get("content-length") ?? 0)
        if (!reply.ok || length > maximumBytes) throw new Error("Imagem indisponível")
        const bytes = Buffer.from(await reply.arrayBuffer())
        if (bytes.length > maximumBytes) throw new Error("Imagem acima do limite")
        return bytes
      },
    }
  }
  cached = { signature, gateway }
  return gateway
}
