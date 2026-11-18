const existingStockTools = new Set(["erp_get_stock", "erp_get_stock_movements", "erp_post_stock_movements"])
const maxRequestBytes = 16 * 1024 * 1024

// This is the same transport limit as the existing MCP endpoint, including
// large document tools. Preserve the original bytes for all forwarded calls.
export async function readMcpPacket(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), inventory: false }
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxRequestBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const message = JSON.parse(new TextDecoder().decode(bytes))
    return { bytes, inventory: message?.method === "tools/call" && existingStockTools.has(message.params?.name) }
  } catch { return { bytes, inventory: false } }
}
