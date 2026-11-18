import { z } from "zod"
import { stockCatalog,stockPermission } from "./stock-catalog.js"
import { Problem } from "../../platform/problem.js"

export const datasets: Record<string, { permission: string; columns: readonly string[] }> = {
  ...Object.fromEntries(Object.entries(stockCatalog).map(([key,source])=>[key,{permission:stockPermission(key),columns:Object.keys(source.columns)}])),
  products: { permission: "catalog.products.read", columns: ["code", "name", "status"] },
  parties: { permission: "catalog.parties.read", columns: ["name", "document", "kind", "status"] },
  sales_orders: { permission: "sales.orders.read", columns: ["number", "customer", "status", "issued_at", "total"] },
  stock_movements: { permission: "inventory.stock.read", columns: ["occurred_at", "product", "warehouse", "quantity", "kind"] },
  audit_log: { permission: "platform.audit.read", columns: ["created_at", "actor", "action", "entity_type"] },
}
const inputSchema = z.strictObject({ name: z.string(), dataset: z.string(), columns: z.array(z.string()), filters: z.record(z.string(), z.unknown()).default({}), visibility: z.string().default("private") })
function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
const control = /[\u0000-\u001f\u007f-\u009f]/u
export function reportInput(value: unknown) {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) invalid("Relatório inválido ou contém campos desconhecidos")
  const input = parsed.data
  input.name = input.name.trim()
  if (!input.name || Buffer.byteLength(input.name) > 120 || control.test(input.name)) invalid("Nome deve ter entre 1 e 120 caracteres")
  const dataset = Object.hasOwn(datasets, input.dataset) ? datasets[input.dataset] : undefined
  if (!dataset) invalid("Fonte de dados inválida")
  input.columns = [...new Set(input.columns)]
  if (!input.columns.length || input.columns.length > dataset.columns.length || input.columns.some(column => !dataset.columns.includes(column))) invalid("Selecione somente colunas permitidas para a fonte")
  if (!["private", "tenant"].includes(input.visibility)) invalid("Visibilidade inválida")
  if (Object.keys(input.filters).length > dataset.columns.length || Object.entries(input.filters).some(([key, value]) => !dataset.columns.includes(key) || !["string", "number", "boolean", "bigint"].includes(typeof value) || typeof value === "string" && (Buffer.byteLength(value) > 200 || control.test(value)))) invalid("Filtros contêm campo ou valor inválido")
  return { input, permission: dataset.permission }
}
