import { typescriptOrigin } from "@/server/bff/erp-backend"

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export async function POST(request: Request, { params }: { params: Promise<{ tenantId: string; accountId: string }> }) {
  const { tenantId, accountId } = await params,
    id = new URL(request.url).searchParams.get("data.id")
  const signature = request.headers.get("x-signature"),
    requestId = request.headers.get("x-request-id")
  if (!signature || !requestId) return new Response(null, { status: 401 })
  if (!uuid.test(tenantId) || !uuid.test(accountId) || !id || !/^\d{1,25}$/.test(id))
    return new Response(null, { status: 400 })
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    return new Response(null, { status: 415 })
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = []
  if (!reader) return new Response(null, { status: 400 })
  let bytes = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    bytes += part.value.byteLength
    if (bytes > 32768) {
      await reader.cancel()
      return new Response(null, { status: 413 })
    }
    chunks.push(part.value)
  }
  try {
    const origin = typescriptOrigin({ ERP_TYPESCRIPT_API_URL: process.env.ERP_TYPESCRIPT_API_URL })
    const url = new URL(`/integrations/finance/mercadopago/${tenantId}/${accountId}`, origin)
    url.searchParams.set("data.id", id)
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-signature": signature, "x-request-id": requestId },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(15000),
    })
    await response.body?.cancel()
    return new Response(null, { status: response.status, headers: { "cache-control": "no-store" } })
  } catch {
    return new Response(null, { status: 503 })
  }
}
