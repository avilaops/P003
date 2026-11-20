import { Problem } from "./problem.js"

// Server-only channel to the public catalog Worker. The credential never reaches a response or a log.
export type CatalogMedia = {
  tenantId: string
  publish(payload: unknown): Promise<void>
  /** Stores an immutable upload under ludus/catalogo/uploads/; the Worker verifies the SHA-256. */
  upload?(key: string, mediaType: string, sha256: string, bytes: Uint8Array): Promise<void>
  /** Reads a private object under ludus/catalogo/; rejects when unavailable or above the limit. */
  readPrivate?(key: string, maximumBytes: number): Promise<Buffer>
}
export type CatalogMediaSettings = { origin: string; token: string; tenantId: string }

const uploadPrefix = "ludus/catalogo/uploads/"

export function createCatalogMedia(settings: CatalogMediaSettings, fetcher: typeof fetch = fetch): CatalogMedia {
  const authorization = `Bearer ${settings.token}`
  return {
    tenantId: settings.tenantId,
    async publish(payload) {
      const reply = await fetcher(`${settings.origin}/midias/_publish`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(payload),
      }).catch(() => { throw new Problem(409, "domain_conflict", "Publicação pendente. Repita para conferir a mesma versão") })
      if (!reply.ok) throw new Problem(409, "domain_conflict", "Publicação não confirmada. Confira a versão atual antes de repetir")
    },
    async upload(key, mediaType, sha256, bytes) {
      if (!key.startsWith(uploadPrefix)) throw new Problem(422, "invalid_input", "Localizador de imagem inválido")
      const reply = await fetcher(`${settings.origin}/midias/_upload/${key.slice(uploadPrefix.length)}`, {
        method: "PUT", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization, "content-type": mediaType, "x-content-sha256": sha256 },
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      }).catch(() => { throw new Problem(409, "domain_conflict", "Envio não confirmado; a versão anterior foi preservada") })
      if (!reply.ok) throw new Problem(409, "domain_conflict", "Não foi possível registrar a foto no R2")
    },
    async readPrivate(key, maximumBytes) {
      const reply = await fetcher(`${settings.origin}/midias/_private/${key}`, { headers: { authorization }, redirect: "error", signal: AbortSignal.timeout(20_000) })
      if (!reply.ok || Number(reply.headers.get("content-length") ?? 0) > maximumBytes) throw new Error("Imagem indisponível")
      const bytes = Buffer.from(await reply.arrayBuffer())
      if (bytes.length > maximumBytes) throw new Error("Imagem acima do limite")
      return bytes
    },
  }
}
