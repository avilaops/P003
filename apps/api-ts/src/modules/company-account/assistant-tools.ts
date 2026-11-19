import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { authorizeRequest, type AccessDependencies } from "../../platform/access.js"

/** Falha de uma ferramenta com o status e a mensagem do contrato do assistente. */
export class ChatError extends Error {
  constructor(readonly status: 403 | 422 | 429 | 503, readonly title: string) { super(title) }
}
export const unavailable = (title: string) => new ChatError(503, title)
export const invalidChat = (title: string) => new ChatError(422, title)

export type CallArguments = { kind: "search"; q: string } | { kind: "recent-orders" } | { kind: "order"; id: string }

const searchTools = ["localizar_funcionalidade", "buscar_produtos", "consultar_estoque", "buscar_clientes"]
const search = z.strictObject({ q: z.string() })
const empty = z.strictObject({})

export function searchArguments(value: unknown): { q: string } {
  const parsed = search.safeParse(value)
  if (!parsed.success) throw invalidChat("Argumentos da consulta inválidos.")
  const q = parsed.data.q.trim()
  if (!q || [...q].length > 160) throw invalidChat("Informe um nome ou SKU de até 160 caracteres.")
  return { q }
}

/** O modelo só fornece um termo de busca; o servidor decide rota, permissão e tenant. */
export function parseCall(name: string, value: unknown, question: string): CallArguments {
  if (searchTools.includes(name)) return { kind: "search", ...searchArguments(value) }
  if (name === "listar_pedidos") {
    if (!empty.safeParse(value).success) throw invalidChat("A listagem de pedidos não aceita filtros ou outra empresa.")
    return { kind: "recent-orders" }
  }
  if (name === "consultar_pedido") {
    if (!empty.safeParse(value).success) throw invalidChat("O identificador do pedido deve ser informado na pergunta, não nos argumentos da ferramenta.")
    const ids = new Set(question.split(/[^0-9a-fA-F-]+/).filter(token => /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(token))
      .map(token => token.toLowerCase().replaceAll("-", "").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")))
    if (ids.size !== 1) throw invalidChat("Informe exatamente um identificador UUID de pedido na pergunta.")
    return { kind: "order", id: [...ids][0]! }
  }
  throw invalidChat("Ferramenta não autorizada. Nenhuma ação foi executada.")
}

export function toolDefinitions() {
  const tools: unknown[] = [
    ["localizar_funcionalidade", "Localizar uma tela do ERP. q: produto, estoque, cliente, pedido, financeiro, receber ou pagar."],
    ["buscar_produtos", "Consultar produtos reais da empresa pelo nome ou SKU. q deve ser apenas o nome ou SKU solicitado."],
    ["consultar_estoque", "Consultar saldo, reservado e disponível de produtos pelo nome ou SKU. q deve ser apenas o nome ou SKU solicitado."],
    ["buscar_clientes", "Buscar clientes pelo nome, razão social ou documento. q deve ser apenas o nome ou documento informado, nunca a pergunta inteira. Retorna até cinco clientes."],
  ].map(([name, description]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: { q: { type: "string", minLength: 1, maxLength: 160 } }, required: ["q"], additionalProperties: false } } }))
  tools.push({ type: "function", function: { name: "listar_pedidos", description: "Listar até cinco pedidos de venda mais recentes da empresa. Não filtra por cliente, status ou período e não calcula totais gerais.", parameters: { type: "object", properties: {}, additionalProperties: false } } })
  tools.push({ type: "function", function: { name: "consultar_pedido", description: "Consultar o resumo do pedido de venda identificado na pergunta atual. O servidor extrai o UUID exato da pergunta. Esta ferramenta não recebe argumentos.", parameters: { type: "object", properties: {}, additionalProperties: false } } })
  return tools
}

// O servidor é dono de toda rota e permissão do catálogo.
const PAGES: readonly [string, string, string, string][] = [
  ["Produtos", "/cadastros/produtos", "catalog.products.read", "produto produtos catálogo catalogo sku preço preco"],
  ["Estoque", "/estoque/saldos", "inventory.stock.read", "estoque saldo saldos disponível disponivel reservado"],
  ["Clientes e fornecedores", "/cadastros/clientes-fornecedores", "catalog.parties.read", "cliente clientes fornecedor fornecedores"],
  ["Pedidos de venda", "/vendas/pedidos", "sales.orders.read", "pedido pedidos venda vendas"],
  ["Contas a receber", "/financeiro/contas-receber", "finance.receivables.read", "financeiro finanças receber recebimento"],
  ["Contas a pagar", "/financeiro/contas-pagar", "finance.payables.read", "financeiro finanças pagar pagamento"],
]
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** Pedidos explícitos de tela usam o catálogo autorizado, sem pedir ao modelo para distinguir tela de dado. */
export function navigationRequest(question: string): { q: string } | undefined {
  const list = words(question), normalized = list.join(" ")
  const where = ["onde vejo", "onde encontro", "onde fica", "onde ficam", "onde acesso", "onde consultar"].some(phrase => normalized.includes(phrase))
  const screen = ["tela", "telas", "menu", "menus", "página", "páginas", "pagina", "paginas", "funcionalidade", "funcionalidades"].some(word => list.includes(word))
  const open = ["abrir", "abra", "acessar", "acesse", "ver", "vejo", "mostra", "mostre", "mostrar", "localizar", "localize", "encontrar", "encontre"].some(word => list.includes(word))
  if (!where && !(screen && open)) return undefined
  const terms = PAGES.flatMap(([, , , keywords]) => keywords.split(" ").filter(keyword => list.includes(keyword)).slice(0, 1))
  return { q: terms.length ? terms.join(" ") : "funcionalidade desconhecida" }
}

type Credentials = { authorization?: string | string[] | undefined; "x-tenant-id"?: string | string[] | undefined }

/** Executa uma leitura nas rotas já protegidas do próprio ERP, com as credenciais do solicitante. */
async function read(app: FastifyInstance, headers: Credentials, url: string): Promise<any> {
  const forwarded: Record<string, string> = {}
  for (const name of ["authorization", "x-tenant-id", "x-request-id"] as const) { const value = (headers as Record<string, unknown>)[name]; if (typeof value === "string") forwarded[name] = value }
  const response = await app.inject({ method: "GET", url, headers: forwarded })
  if (response.statusCode === 403) throw new ChatError(403, "Consulta recusada: você não tem permissão nesta empresa.")
  if (response.statusCode === 404) return null
  if (response.statusCode === 422) throw invalidChat("Consulta inválida.")
  if (response.statusCode !== 200 || response.rawPayload.length > 32_768) throw unavailable("A consulta ao ERP falhou. Nenhum resultado foi confirmado.")
  try { return JSON.parse(response.body) } catch { throw unavailable("Resposta do ERP inválida.") }
}

const records = (value: any): any[] => Array.isArray(value?.data) ? value.data : (() => { throw unavailable("Resposta do ERP inválida.") })()
const recordId = (record: any): string => typeof record?.id === "string" && z.guid().safeParse(record.id).success ? record.id : (() => { throw unavailable("Identificador retornado pelo ERP inválido.") })()

export function orderRecord(record: any) {
  const id = recordId(record)
  if (typeof record.number !== "string") throw unavailable("Número do pedido indisponível.")
  return { title: `PV-${record.number.padStart(6, "0")}`, id, number: record.number, customerName: record.customerName, amount: record.amount, dueDate: record.dueDate, status: record.status, href: `/vendas/pedidos/${id}` }
}

export async function executeTool(app: FastifyInstance, dependencies: AccessDependencies, request: { headers: Credentials & Record<string, unknown>; method?: string },
  name: string, args: CallArguments): Promise<Record<string, unknown>> {
  const q = (value: string) => new URLSearchParams({ q: value, offset: "0", limit: "5" }).toString()
  if (name === "listar_pedidos" && args.kind === "recent-orders") {
    const value = await read(app, request.headers, "/api/v1/orders?offset=0&limit=5")
    return { tool: name, origin: "API ERP · Pedidos recentes", scope: "Pedidos mais recentes da empresa, sem filtros por cliente, situação ou período.", data: records(value).map(orderRecord), total: value.total, limit: 5 }
  }
  if (name === "consultar_pedido" && args.kind === "order") {
    const value = await read(app, request.headers, `/api/v1/orders/${args.id}`)
    const data = value === null ? [] : [orderRecord(value.data)]
    return { tool: name, origin: "API ERP · Pedido", total: data.length, data, limit: 1 }
  }
  if (args.kind !== "search" || !searchTools.includes(name)) throw invalidChat("Argumentos incompatíveis com a ferramenta.")
  if (name === "buscar_clientes") {
    const value = await read(app, request.headers, `/api/v1/parties?${q(args.q)}&role=customer`)
    const data = records(value).map(record => ({ title: record.legalName, tradeName: record.tradeName, status: record.status, href: `/cadastros/clientes-fornecedores/${recordId(record)}` }))
    return { tool: name, origin: "API ERP · Clientes", data, total: value.total, limit: 5 }
  }
  if (name === "localizar_funcionalidade") {
    const rights = await authorizeRequest(request as never, dependencies, async context => context.permissions, false)
    const terms = args.q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => [...word].length >= 3)
    const candidates = PAGES.filter(([, , , keywords]) => terms.some(word => keywords.split(" ").includes(word)))
    const data = candidates.filter(([, , permission]) => rights.includes(permission)).map(([title, href]) => ({ title, href }))
    if (candidates.length && !data.length) throw new ChatError(403, "Consulta recusada: você não tem permissão nesta empresa.")
    return { tool: name, origin: "Catálogo de funcionalidades do ERP", data, total: data.length }
  }
  const products = name === "buscar_produtos"
  const value = await read(app, request.headers, `${products ? "/api/v1/products" : "/api/v1/stock"}?${q(args.q)}`)
  const data = records(value).map(record => {
    const id = products ? record.id : record.productId
    const item: Record<string, unknown> = { title: record.name, sku: record.sku, unit: record.unit, status: record.status, href: `/cadastros/produtos/${typeof id === "string" ? id : ""}` }
    if (products) item.basePrice = record.basePrice
    else for (const field of ["quantity", "reserved", "available"]) item[field] = record[field]
    return item
  })
  return { tool: name, origin: products ? "API ERP · Produtos" : "API ERP · Estoque", data, total: value.total, limit: 5 }
}

