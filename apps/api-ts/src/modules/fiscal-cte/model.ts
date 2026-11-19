// Correlaciona o resultado do motor fiscal com o XML CT-e preservado antes de gravar.
// XSD e consistência XMLDSig são do motor (apps/fiscal-engine); aqui não há confiança ICP-Brasil.
import { z } from "zod"
import { sha256 } from "../nfe-email/danfe.js"
import { checkDigit } from "../fiscal-workspace/emission.js"
import { CTE_NS, DS_NS, cents, child, field, optionalChild, parseXml, text } from "./shared.js"
import type { Element } from "@xmldom/xmldom"

export const PROFILE = "PL_CTe_400_NT2026.004_RTC_1.00_2026-10-16"
export const VERSION = "cte-received-v1"
export const SUPPORTED_SCHEMA = "procCTe_v4.00.xsd"
export const MAX_CTE_XML = 2_097_152

const party = z.strictObject({ kind: z.string(), value: z.string(), name: z.string().nullable() })
export const metadataSchema = z.strictObject({
  source: z.literal("cte_distribution"), schemaVersion: z.literal("4.00"), profile: z.literal(PROFILE), environment: z.literal("homologation"),
  companyTaxId: z.string(), accessKey: z.string(), number: z.string(), series: z.string(), issuedAt: z.string(), modal: z.string(),
  documentType: z.enum(["0", "1", "3"]), carrier: party, sender: party.nullable(), dispatcher: party.nullable(), receiver: party.nullable(),
  recipient: party.nullable(), taker: party, takerRole: z.string(), companyRoles: z.array(z.string()), serviceCents: z.string(),
  receivableCents: z.string(), nfeReferences: z.array(z.string()), cteReferences: z.array(z.string()),
  protocol: z.strictObject({ code: z.string(), number: z.string(), receivedAt: z.string(), digest: z.string() }), xmlSha256: z.string(),
  verification: z.strictObject({ layout: z.literal("official_schema_valid"), signature: z.literal("consistent"), certificateTrust: z.literal("not_verified"),
    currentStatus: z.literal("not_queried"), protocolAuthenticity: z.literal("not_verified") }),
})
export type ReceivedCteMetadata = z.infer<typeof metadataSchema>
type Party = z.infer<typeof party>

export function validKey(key: string, models: string[]) {
  return /^\d{6}[0-9A-Z]{12}\d{26}$/.test(key) && models.includes(key.slice(20, 22)) && checkDigit(key.slice(0, 43)) === Number(key[43])
}
function readParty(node: Element): Party {
  const found = (["CNPJ", "CPF"] as const).flatMap(kind => { const id = optionalChild(node, kind); return id ? [{ kind, value: text(id) }] : [] })
  if (found.length !== 1) throw Error("party")
  const name = optionalChild(node, "xNome")
  return { kind: found[0]!.kind, value: found[0]!.value, name: name ? text(name) : null }
}
const optionalParty = (node: Element, name: string) => { const found = optionalChild(node, name); return found ? readParty(found) : null }
const same = (a: Party | null, b: Party | null) => JSON.stringify(a) === JSON.stringify(b)
function references(info: Element, names: string[], nested: boolean) {
  const result: string[] = []
  for (const node of Array.from(info.getElementsByTagName("*"))) {
    if (node.namespaceURI !== CTE_NS || !names.includes(node.localName ?? "")) continue
    const value = nested ? field(node, "chave") : text(node)
    if (!result.includes(value)) result.push(value)
    if (result.length > 2000) throw Error("references")
  }
  return result
}

/** Devolve os metadados conferidos ou `undefined` se o resultado não corresponder ao XML exato. */
export function correlate(result: unknown, xml: string, company: string): ReceivedCteMetadata | undefined {
  try {
    if (!result || typeof result !== "object" || Array.isArray(result) || xml.length === 0 || Buffer.byteLength(xml) > MAX_CTE_XML) return undefined
    const { xml: echoed, ...rest } = result as Record<string, unknown>
    if (echoed !== xml) return undefined
    const parsed = metadataSchema.safeParse(rest)
    if (!parsed.success) return undefined
    const data = parsed.data, key = data.accessKey
    if (data.companyTaxId !== company || data.xmlSha256 !== sha256(xml) || !validKey(key, ["57"])) return undefined
    const root = parseXml(xml, MAX_CTE_XML)
    if (!root || root.localName !== "cteProc" || root.namespaceURI !== CTE_NS || root.getAttribute("versao") !== "4.00") return undefined
    const cte = child(root, "CTe"), info = child(cte, "infCte")
    if (info.getAttribute("versao") !== "4.00" || info.getAttribute("Id") !== "CTe" + key) return undefined
    const ide = child(info, "ide"), issued = field(ide, "dhEmi")
    if (!/^[\x00-\x7f]{19,}$/.test(issued)) return undefined
    if (field(ide, "mod") !== "57" || field(ide, "tpAmb") !== "2" || field(ide, "cUF") !== key.slice(0, 2) ||
      issued.slice(2, 4) + issued.slice(5, 7) !== key.slice(2, 6) || field(ide, "serie") !== data.series || data.series.padStart(3, "0") !== key.slice(22, 25) ||
      field(ide, "nCT") !== data.number || data.number.padStart(9, "0") !== key.slice(25, 34) || field(ide, "tpEmis") !== key[34] ||
      field(ide, "cCT") !== key.slice(35, 43) || field(ide, "cDV") !== key.slice(43) || issued !== data.issuedAt ||
      field(ide, "modal") !== data.modal || field(ide, "tpCTe") !== data.documentType) return undefined
    const carrier = readParty(child(info, "emit"))
    const sender = optionalParty(info, "rem"), dispatcher = optionalParty(info, "exped"), receiver = optionalParty(info, "receb"), recipient = optionalParty(info, "dest")
    if (carrier.value.padStart(14, "0") !== key.slice(6, 20)) return undefined
    const toma3 = optionalChild(ide, "toma3"), toma4 = optionalChild(ide, "toma4")
    if (!toma3 === !toma4) return undefined
    let takerRole: string, taker: Party | null
    if (toma3) {
      const roles: Record<string, [string, Party | null]> = { "0": ["sender", sender], "1": ["dispatcher", dispatcher], "2": ["receiver", receiver], "3": ["recipient", recipient] }
      const found = roles[field(toma3, "toma")]
      if (!found) return undefined
      ;[takerRole, taker] = found
    } else {
      if (field(toma4!, "toma") !== "4") return undefined
      ;[takerRole, taker] = ["other", readParty(toma4!)]
    }
    if (!taker) return undefined
    const roles = (Object.entries({ carrier, sender, dispatcher, receiver, recipient, taker }) as [string, Party | null][])
      .filter(([, person]) => person?.kind === "CNPJ" && person.value === company).map(([name]) => name)
    const authorized = Array.from(info.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === "autXML" && (n as Element).namespaceURI === CTE_NS).map(readParty)
    if (authorized.some(person => person.kind === "CNPJ" && person.value === company)) roles.push("authorized_xml")
    const nfe = references(info, ["infNFe"], true), cteRefs = references(info, ["chCTe", "chCte", "chCTeMultimodal"], false)
    const values = child(info, "vPrest")
    if (!same(carrier, data.carrier) || !same(sender, data.sender) || !same(dispatcher, data.dispatcher) || !same(receiver, data.receiver) ||
      !same(recipient, data.recipient) || !same(taker, data.taker) || takerRole !== data.takerRole || !roles.length ||
      JSON.stringify(roles) !== JSON.stringify(data.companyRoles) || cents(field(values, "vTPrest")) !== data.serviceCents ||
      cents(field(values, "vRec")) !== data.receivableCents || JSON.stringify(nfe) !== JSON.stringify(data.nfeReferences) ||
      JSON.stringify(cteRefs) !== JSON.stringify(data.cteReferences) || nfe.some(ref => !validKey(ref, ["55"])) ||
      cteRefs.some(ref => !validKey(ref, ["57", "67"]) || ref === key)) return undefined
    const protocol = child(root, "protCTe"), receipt = child(protocol, "infProt")
    if (protocol.getAttribute("versao") !== "4.00" || field(receipt, "tpAmb") !== "2" || field(receipt, "chCTe") !== key ||
      field(receipt, "cStat") !== data.protocol.code || field(receipt, "nProt") !== data.protocol.number ||
      field(receipt, "dhRecbto") !== data.protocol.receivedAt || field(receipt, "digVal") !== data.protocol.digest) return undefined
    const reference = child(child(child(cte, "Signature", DS_NS), "SignedInfo", DS_NS), "Reference", DS_NS)
    if (reference.getAttribute("URI") !== "#CTe" + key || field(reference, "DigestValue", DS_NS) !== data.protocol.digest) return undefined
    return data
  } catch { return undefined }
}

/** Fatos comerciais usados pelos vínculos: transportadora CNPJ e valor da prestação. */
export function commercialFacts(metadata: unknown, xml: string, company: string) {
  const data = correlate({ ...(metadata as object), xml }, xml, company)
  if (!data || data.carrier.kind !== "CNPJ" || !/^\d{1,15}$/.test(data.serviceCents)) return undefined
  return { carrierTaxId: data.carrier.value, carrierName: data.carrier.name, serviceCents: BigInt(data.serviceCents) }
}
