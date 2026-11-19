import { Problem } from "./problem.js"

// Server-only channel to the public catalog Worker. The credential never reaches a response or a log.
export type CatalogMedia = {
  tenantId: string
  publish(payload: unknown): Promise<void>
  /** Stores an immutable upload under ludus/catalogo/uploads/; the Worker verifies the SHA-256. */
  upload(key: string, mediaType: string, sha256: string, bytes: Uint8Array): Promise<void>
  /** Reads a private catalog object (relative to ludus/catalogo/) up to the media size limit. */
  readPrivate(key: string): Promise<Uint8Array>
}
export type CatalogMediaSettings = { origin: string; token: string; tenantId: string }

export const catalogMediaLimit = 20_000_000
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
    async readPrivate(key) {
      const reply = await fetcher(`${settings.origin}/midias/_private/${key}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(20_000), headers: { authorization },
      }).catch(() => { throw new Problem(409, "domain_conflict", "Imagem temporariamente indisponível") })
      const declared = Number(reply.headers.get("content-length") ?? "0")
      if (!reply.ok || declared > catalogMediaLimit || !reply.body) throw new Problem(409, "domain_conflict", "Imagem indisponível")
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of reply.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > catalogMediaLimit) throw new Problem(409, "domain_conflict", "Imagem acima do limite")
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },
  }
}
