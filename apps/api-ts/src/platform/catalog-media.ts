import { Problem } from "./problem.js"

// Server-only channel to the public catalog Worker. The credential never reaches a response or a log.
export type CatalogMedia = {
  tenantId: string
  publish(payload: unknown): Promise<void>
  /** Reads a private object under ludus/catalogo/; rejects when unavailable or above the limit. */
  readPrivate?(key: string, maximumBytes: number): Promise<Buffer>
}
export type CatalogMediaSettings = { origin: string; token: string; tenantId: string }

export function createCatalogMedia(settings: CatalogMediaSettings, fetcher: typeof fetch = fetch): CatalogMedia {
  return {
    tenantId: settings.tenantId,
    async publish(payload) {
      const reply = await fetcher(`${settings.origin}/midias/_publish`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json" }, body: JSON.stringify(payload),
      }).catch(() => { throw new Problem(409, "domain_conflict", "Publicação pendente. Repita para conferir a mesma versão") })
      if (!reply.ok) throw new Problem(409, "domain_conflict", "Publicação não confirmada. Confira a versão atual antes de repetir")
    },
    async readPrivate(key, maximumBytes) {
      const reply = await fetcher(`${settings.origin}/midias/_private/${key}`, { headers: { authorization: `Bearer ${settings.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000) })
      if (!reply.ok || Number(reply.headers.get("content-length") ?? 0) > maximumBytes) throw new Error("Imagem indisponível")
      const bytes = Buffer.from(await reply.arrayBuffer())
      if (bytes.length > maximumBytes) throw new Error("Imagem acima do limite")
      return bytes
    },
  }
}
