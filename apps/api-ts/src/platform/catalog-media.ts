import { Problem } from "./problem.js"

// Server-only channel to the public catalog Worker. The credential never reaches a response or a log.
export type CatalogMedia = { tenantId: string; publish(payload: unknown): Promise<void> }
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
  }
}
