import { z } from "zod"
import { stockCatalog,stockPermission } from "./stock-catalog.js"
import { Problem } from "../../platform/problem.js"
import { totalSchema, validateLayout } from "./engine/definition.js"
import { engineSource } from "./engine/registry.js"

/** Fontes fora do motor: estoque (executor próprio, `stock-run.ts`) e cadastros ainda só como definição. */
export const datasets: Record<string, { permissions: string[]; columns: readonly string[] }> = {
  ...Object.fromEntries(Object.entries(stockCatalog).map(([key,source])=>[key,{permissions:[...new Set(["inventory.stock.read",stockPermission(key)])],columns:Object.keys(source.columns)}])),
  products: { permissions: ["catalog.products.read"], columns: ["code", "name", "status"] },
  parties: { permissions: ["catalog.parties.read"], columns: ["name", "document", "kind", "status"] },
  stock_movements: { permissions: ["inventory.stock.read"], columns: ["occurred_at", "product", "warehouse", "quantity", "kind"] },
}
const inputSchema = z.strictObject({ name: z.string(), dataset: z.string(), columns: z.array(z.string()).max(60), filters: z.record(z.string(), z.unknown()).default({}),
  visibility: z.string().default("private"), groupBy: z.array(z.string()).max(2).default([]), totals: z.array(totalSchema).max(20).default([]) })
function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
const control = /[\u0000-\u001f\u007f-\u009f]/u
export function reportInput(value: unknown) {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) invalid("Relatório inválido ou contém campos desconhecidos")
  const input = parsed.data
  input.name = input.name.trim()
  if (!input.name || Buffer.byteLength(input.name) > 120 || control.test(input.name)) invalid("Nome deve ter entre 1 e 120 caracteres")
  if (!["private", "tenant"].includes(input.visibility)) invalid("Visibilidade inválida")
  const source = engineSource(input.dataset)
  if (source) {
    const layout = validateLayout(source, input)
    return { input: { ...input, ...layout }, permissions: [...source.permissions] }
  }
  const dataset = Object.hasOwn(datasets, input.dataset) ? datasets[input.dataset] : undefined
  if (!dataset) invalid("Fonte de dados inválida")
  if (input.groupBy.length || input.totals.length) invalid("Agrupamentos e totais exigem uma fonte do motor de relatórios")
  input.columns = [...new Set(input.columns)]
  if (!input.columns.length || input.columns.length > dataset.columns.length || input.columns.some(column => !dataset.columns.includes(column))) invalid("Selecione somente colunas permitidas para a fonte")
  if (Object.keys(input.filters).length > dataset.columns.length || Object.entries(input.filters).some(([key, value]) => !dataset.columns.includes(key) || !["string", "number", "boolean", "bigint"].includes(typeof value) || typeof value === "string" && (Buffer.byteLength(value) > 200 || control.test(value)))) invalid("Filtros contêm campo ou valor inválido")
  return { input, permissions: dataset.permissions }
}
