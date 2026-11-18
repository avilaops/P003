import { createHash } from "node:crypto"
import { Problem } from "../../platform/problem.js"

export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
type RenderInput = { tenantId: string; authorization: string; xml: string; accessKey: string; environment: string }

export async function renderDanfe(input: RenderInput, request = fetch, origin = process.env.ERP_FISCAL_API_URL || "http://127.0.0.1:8080") {
  const unavailable = () => new Problem(502, "danfe_unavailable", "Não foi possível gerar o DANFE para anexar à mensagem")
  try {
    const api = new URL(origin)
    if (api.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
        api.username || api.password || api.pathname !== "/" || api.search || api.hash) throw unavailable()
    const response = await request(new URL("/api/v1/fiscal/danfe", api), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(75_000),
      headers: { authorization: input.authorization, "x-tenant-id": input.tenantId, "content-type": "application/json", accept: "application/pdf" },
      body: JSON.stringify({ xml: input.xml }),
    })
    const reader = response.body?.getReader()
    if (!response.ok || !reader || response.headers.get("content-type")?.split(";")[0] !== "application/pdf" ||
        response.headers.get("content-disposition") !== `attachment; filename="DANFE-${input.accessKey}.pdf"` ||
        response.headers.get("x-nfe-environment") !== (input.environment === "homologation" ? "2" : "1") ||
        response.headers.get("x-xml-sha256") !== sha256(input.xml)) {
      await reader?.cancel()
      throw unavailable()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw unavailable() }
      chunks.push(value)
    }
    const pdf = Buffer.concat(chunks)
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-" || sha256(pdf) !== response.headers.get("x-pdf-sha256")) throw unavailable()
    return pdf
  } catch { throw unavailable() }
}
