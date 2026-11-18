const existingStockTools = new Set([
  "erp_get_production_orders","erp_get_production_orders__id","erp_get_production_stages",
  "erp_post_production_orders","erp_post_production_orders__id__stage","erp_post_production_orders__id__consumptions",
  "erp_post_production_orders__id__consumptions__movement__reverse","erp_post_production_stages","erp_put_production_stages__id",
  "erp_get_stock","erp_get_stock_movements","erp_post_stock_movements",
  "erp_get_warehouses","erp_get_warehouses__id","erp_post_warehouses","erp_put_warehouses__id",
  "erp_get_inventory_settings","erp_put_inventory_settings","erp_get_inventory_counts","erp_get_inventory_counts__id",
  "erp_post_inventory_counts","erp_post_inventory_counts__id__lines","erp_post_inventory_counts__id__approve",
])
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
