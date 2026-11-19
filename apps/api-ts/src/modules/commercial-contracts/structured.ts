// Células do documento estruturado (modelo Ludus revisado). Nenhum dado de signatário,
// recebimento, classificação jurídica ou logística é inferido aqui.
import { conflict, invalid } from "../../platform/domain.js"
import { fixed } from "../sales/fixed.js"

type Json = any
const MARKER = "Pedido — subtotal dos produtos"
const ITEM_COLUMNS = ["código / modelo", "descrição", "quantidade", "preço unitário", "preço total"] as const
const FINISHES = [["structureColor", "Estrutura"], ["swingArmColor", "Braços"], ["plateHolderType", "Tipo de anilheiro"], ["upholsteryColor", "Estofado"]] as const

const active = (names: Set<string>) => names.has(MARKER) && names.has("Produto 1 — descrição")
const str = (value: unknown) => typeof value === "string" ? value : undefined

/** Grupo e opção de um campo de marcação ("Grupo — Opção"), só no documento estruturado. */
export function choiceMetadata(template: Json, name: string): [string, string] | undefined {
  const fields = Array.isArray(template?.fields) ? template.fields : undefined
  if (!fields || !fields.some((f: Json) => f?.name === MARKER) || !fields.some((f: Json) => f?.name === "Produto 1 — descrição")) return undefined
  const group = choiceGroup(name)
  const split = name.lastIndexOf(" — ")
  return group && split >= 0 ? [group, name.slice(split + 3)] : undefined
}

function currency(cents: bigint) {
  const magnitude = cents < 0n ? -cents : cents
  const whole = (magnitude / 100n).toString()
  return `${cents < 0n ? "-" : ""}${whole.replace(/\B(?=(\d{3})+$)/g, ".")},${(magnitude % 100n).toString().padStart(2, "0")}`
}

function sourceMoney(value: unknown) {
  try { if (typeof value === "string") return fixed(value, 2) } catch { /* convertido abaixo */ }
  throw conflict("Os valores do pedido não estão em centavos exatos; confira a origem antes de gerar")
}

function quantity(value: unknown, unit: unknown) {
  if (typeof value !== "string") throw conflict("Quantidade do pedido inválida")
  const [whole, fraction = ""] = value.split(/\.(.*)/s)
  try { fixed(value.includes(".") ? value : `${value}.000000`, 6) } catch { throw conflict("Quantidade do pedido inválida") }
  const trimmed = fraction.replace(/0+$/, "")
  const raw = trimmed ? `${whole},${trimmed}` : whole!
  const text = str(unit) ?? ""
  return text ? `${raw} ${text}` : raw
}

function description(item: Json) {
  let text = str(item?.name) ?? ""
  for (const [key, label] of FINISHES) { const value = str(item?.[key]); if (value) text += ` · ${label}: ${value}` }
  return text
}

const joined = (value: Json, keys: string[], separator: string) => keys.map(key => str(value?.[key])).filter(text => text).join(separator)

export function applyDefaults(snapshot: Json, names: Set<string>, values: Map<string, string>) {
  if (!active(names)) return
  const items = snapshot?.items
  if (!Array.isArray(items)) throw conflict("Confira os produtos do pedido")
  let capacity = 0
  while (capacity < 200 && ITEM_COLUMNS.every(column => names.has(`Produto ${capacity + 1} — ${column}`))) capacity++
  if (items.length > capacity) throw conflict("O pedido tem mais produtos que as linhas do modelo; use um anexo que comporte todos os itens")
  const total = sourceMoney(snapshot?.order?.amount)
  let subtotal = 0n
  const known = new Map<string, string>()
  for (let row = 1; row <= capacity; row++) {
    const item = items[row - 1]
    let cells: string[]
    if (item !== undefined) {
      const amount = sourceMoney(item?.amount)
      subtotal += amount
      cells = [str(item?.sku) ?? "", description(item), quantity(item?.quantity, item?.unit), currency(sourceMoney(item?.unitPrice)), currency(amount)]
    } else cells = ITEM_COLUMNS.map(() => "")
    // Linhas vazias também valem: a entrada não pode inventar itens do pedido.
    ITEM_COLUMNS.forEach((column, index) => known.set(`Produto ${row} — ${column}`, cells[index]!))
  }
  known.set("pedido_total", currency(total))
  known.set(MARKER, currency(subtotal))
  known.set("Pedido — descontos / acréscimos", currency(total - subtotal))
  const addresses = snapshot?.customer?.addresses
  if (Array.isArray(addresses)) {
    const address = addresses.find((a: Json) => a?.primary === true) ?? addresses[0]
    if (address !== undefined) {
      for (const [label, text] of [
        ["logradouro e número", joined(address, ["street", "number", "complement"], ", ")],
        ["bairro", joined(address, ["district"], "")],
        ["CEP", joined(address, ["postalCode"], "")],
        ["cidade / UF", joined(address, ["city", "state"], " / ")],
      ] as const) if (text) known.set(`Compradora — endereço — ${label}`, text)
    }
  }
  const phone = str(snapshot?.customer?.phone)
  if (phone) known.set("Telefone / WhatsApp da compradora", phone)
  const terms = snapshot?.negotiatedPayments
  if (terms !== undefined && terms !== null) {
    const entry = terms.entryAmountCents
    if (!Number.isSafeInteger(entry) || entry < 0) throw conflict("Entrada negociada inválida")
    if (!Array.isArray(terms.installments)) throw conflict("Parcelas negociadas inválidas")
    let balance = 0n
    for (const installment of terms.installments) {
      const amount = installment?.amountCents
      if (!Number.isSafeInteger(amount) || amount <= 0) throw conflict("Parcela negociada inválida")
      balance += BigInt(amount)
    }
    if (BigInt(entry) + balance !== total) throw conflict("Entrada e parcelas negociadas divergem do total do pedido")
    known.set("Valor acordado de entrada (R$)", currency(BigInt(entry)))
    known.set("Valor remanescente (R$)", currency(balance))
  }
  for (const [name, value] of known) if (names.has(name)) values.set(name, value)
}

const GROUPS: [string, string[]][] = [
  ["Compradora — natureza", ["Pessoa física", "Pessoa jurídica"]],
  ["Aquisição — destinação", ["Uso próprio como destinatária final", "Uso profissional / empresarial", "Revenda", "Locação", "Outra"]],
  ["Pagamento — condição", ["À vista", "02 parcelas", "Outra"]],
  ["Saldo — vencimento", ["Na comunicação + 5 dias úteis", "Data específica"]],
  ["Técnica — manual em português", ["Sim", "Não aplicável", "A entregar"]],
  ["Técnica — conectividade", ["Sim", "Não"]],
  ["Frete — RESPONSÁVEL PELA CONTRATAÇÃO DO FRETE", ["Compradora", "Vendedora"]],
  ["Frete — RESPONSÁVEL PELO PAGAMENTO DO FRETE", ["Compradora", "Vendedora"]],
  ["Frete — modalidade", ["Retirada", "Entrega no endereço", "Outra"]],
  ["Montagem — contratação", ["Contratada", "Não contratada"]],
  ["Instalação — contratação", ["Contratada em separado", "Não contratada"]],
  ["Reserva de domínio", ["Sim", "Não"]],
]

function choiceGroup(name: string): string | undefined {
  const split = name.lastIndexOf(" — ")
  if (split < 0) return undefined
  const group = name.slice(0, split), option = name.slice(split + 3)
  if (GROUPS.some(([known, options]) => known === group && options.includes(option))) return group
  if (!group.startsWith("Disponibilidade ")) return undefined
  const rest = group.slice("Disponibilidade ".length)
  const separator = rest.indexOf(" — ")
  if (separator < 0) return undefined
  const row = rest.slice(0, separator), kind = rest.slice(separator + 3)
  if (!["1", "2", "3"].includes(row)) return undefined
  return (kind === "origem" && ["Nacional", "Importado"].includes(option)) || (kind === "condição" && ["Estoque", "Encomenda"].includes(option)) ? group : undefined
}

function nativeMoney(raw: string, signed: boolean) {
  let text = raw.trim()
  if (signed && text.startsWith("-")) text = text.slice(1)
  const comma = text.indexOf(",")
  if (comma < 0) return false
  const whole = text.slice(0, comma), fraction = text.slice(comma + 1)
  if (!/^[0-9]{2}$/.test(fraction)) return false
  const groups = whole.split(".")
  if (groups.length > 1 && (!groups[0] || groups[0].length > 3 || groups.slice(1).some(group => group.length !== 3))) return false
  try { fixed(`${groups.join("")}.${fraction}`, 2); return true } catch { return false }
}

function calendar(day: string, month: number, year: number) {
  if (!(year >= 1 && year <= 9999) || !/^[0-9]{1,2}$/.test(day) || !(month >= 1 && month <= 12)) return false
  const value = Number(day)
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return value >= 1 && value <= days
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
function dates(values: Map<string, string>) {
  const get = (name: string) => (values.get(name) ?? "").trim()
  let day = get("Data do contrato — dia"), month = get("Data do contrato — mês"), year = get("Data do contrato — ano (dois últimos dígitos)")
  if (day || month || year) {
    const index = MONTHS.indexOf(month.toLowerCase())
    if (!/^[0-9]{2}$/.test(year) || index < 0 || !calendar(day, index + 1, 2000 + Number(year))) return false
  }
  day = get("Pedido — data de emissão — dia"); month = get("Pedido — data de emissão — mês"); year = get("Pedido — data de emissão — ano")
  if ((day || month || year) && (!/^[0-9]{2}$/.test(month) || !/^[0-9]{4}$/.test(year) || !calendar(day, Number(month), Number(year)))) return false
  const due = get("Saldo — data de vencimento")
  if (due) {
    const match = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/.exec(due)
    if (!match || !calendar(match[1]!, Number(match[2]), Number(match[3]))) return false
  }
  return true
}

const MONETARY = new Set(["pedido_total", MARKER, "Pedido — descontos / acréscimos", "Valor acordado de entrada (R$)", "Valor remanescente (R$)", "Logística — VALOR DO FRETE", "Logística — VALOR DA MONTAGEM"])

export function validateStructured(values: Map<string, string>, template: Json) {
  const names = new Set<string>((Array.isArray(template?.fields) ? template.fields : []).map((f: Json) => f?.name).filter((n: unknown): n is string => typeof n === "string"))
  if (!active(names)) return
  const marked = new Set<string>()
  for (const [name, raw] of [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const value = raw.trim()
    const group = choiceGroup(name)
    if (group && value && (value !== "X" || marked.has(group) || !marked.add(group)))
      throw invalid("Marque apenas uma opção por grupo, usando X ou deixando em branco")
    const monetary = MONETARY.has(name) || (name.startsWith("Produto ") && (name.endsWith(" — preço unitário") || name.endsWith(" — preço total")))
    if (monetary && value && !nativeMoney(value, name === "Pedido — descontos / acréscimos"))
      throw invalid("Informe moeda no formato brasileiro, por exemplo 1.234,56, sem repetir R$")
  }
  if (!dates(values)) throw invalid("Confira as datas completas e seus dias, meses e anos no formato do documento")
}
