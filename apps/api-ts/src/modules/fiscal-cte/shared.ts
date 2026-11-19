import { DOMParser, type Element } from "@xmldom/xmldom"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { invalid } from "../../platform/domain.js"
import { validDocument } from "../parties/schema.js"

export const prefix = "/api/v1/fiscal/cte-distribution"
export const READ = "fiscal.cte.read"
export const QUERY = "fiscal.cte.query"
export const INSPECT = "fiscal.cte.inspect"
export const LINK = "fiscal.cte.link"
export const CTE_NS = "http://www.portalfiscal.inf.br/cte"
export const DS_NS = "http://www.w3.org/2000/09/xmldsig#"
export const ZERO_NSU = "000000000000000"

const guid = z.guid()
export function documentId(raw: string) {
  if (!guid.safeParse(raw).success) throw invalid("Identificador inválido")
  return raw.toLowerCase()
}

export async function companyTaxId(c: AuthorizedContext) {
  return String((await c.client.query("SELECT tax_id FROM tenants WHERE id=$1", [c.tenantId])).rows[0]!.tax_id)
}
/** CNPJ numérico válido: a distribuição e a conferência CT-e não aceitam CNPJ alfanumérico nem CPF. */
export const numericCnpj = (tax: string) => /^\d{14}$/.test(tax) && validDocument(tax, "juridica")

/** Parser restrito: sem DTD/entidades, com limite de bytes e de nós. Devolve `undefined` se o XML for inválido. */
export function parseXml(xml: string, maxBytes: number): Element | undefined {
  if (!xml.length || Buffer.byteLength(xml) > maxBytes || /<!DOCTYPE|<!ENTITY/i.test(xml) || xml.includes("\0")) return undefined
  try {
    const root = new DOMParser({ onError: () => { throw Error("invalid") } }).parseFromString(xml, "application/xml").documentElement
    if (!root) return undefined
    let count = 0
    const nodes: import("@xmldom/xmldom").Node[] = [root]
    while (nodes.length) {
      const node = nodes.pop()!
      if (++count > 100_000) return undefined
      for (const entry of Array.from(node.childNodes ?? [])) nodes.push(entry)
    }
    return root as Element
  } catch { return undefined }
}

const elements = (node: Element, name: string, ns: string) =>
  Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === name && (n as Element).namespaceURI === ns)
/** Filho único; `undefined` se ausente; erro se duplicado. */
export function optionalChild(node: Element, name: string, ns = CTE_NS) {
  const found = elements(node, name, ns)
  if (found.length > 1) throw Error("duplicated")
  return found[0]
}
export function child(node: Element, name: string, ns = CTE_NS) {
  const found = optionalChild(node, name, ns)
  if (!found) throw Error("missing")
  return found
}
export function text(node: Element) {
  const nodes = Array.from(node.childNodes)
  if (nodes.some(n => n.nodeType === 1)) throw Error("nested")
  const value = nodes.filter(n => n.nodeType === 3 || n.nodeType === 4).map(n => n.nodeValue ?? "").join("")
  if (!value) throw Error("empty")
  return value
}
export const field = (node: Element, name: string, ns = CTE_NS) => text(child(node, name, ns))

/** Valor decimal com duas casas → centavos em string exata. */
export function cents(value: string, maxWhole = 13) {
  const [whole = "", fraction = "00", extra] = value.split(".")
  if (extra !== undefined || !whole || whole.length > maxWhole || whole.length > 1 && whole.startsWith("0") || !/^\d+$/.test(whole) || !/^\d{2}$/.test(fraction)) throw Error("cents")
  return (BigInt(whole) * 100n + BigInt(fraction)).toString()
}
