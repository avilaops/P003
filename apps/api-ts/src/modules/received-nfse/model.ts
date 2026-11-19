// Correlaciona os metadados do motor fiscal com o arquivo nacional exato antes de gravar.
// O XSD é validado no motor (apps/fiscal-engine). Isto não estabelece confiança na assinatura.
import type { Element } from "@xmldom/xmldom"
import { z } from "zod"
import { sha256 } from "../nfe-email/danfe.js"
import { validDocument } from "../parties/schema.js"
import { cents, child, field, parseXml } from "../fiscal-cte/shared.js"

const NS = "http://www.sped.fazenda.gov.br/nfse"
export const MAX_NFSE_XML = 1_048_576

const party = z.strictObject({ kind: z.string(), value: z.string(), name: z.string().nullable() })
export const metadataSchema = z.strictObject({
  source: z.literal("nfse_nacional"), schemaVersion: z.string(), accessKey: z.string().regex(/^\d{50}$/), environment: z.enum(["production", "homologation"]),
  number: z.string(), municipalityCode: z.string(), issuedAt: z.string(), processedAt: z.string(), processingCode: z.string(),
  issuer: party, provider: party, recipient: party, serviceCode: z.string(), description: z.string(), serviceCents: z.string(), netCents: z.string(),
  xmlSha256: z.string(),
  verification: z.strictObject({ layout: z.string(), correction: z.string().nullable().optional(), signature: z.literal("not_verified"), currentStatus: z.literal("not_queried") }),
})
export type ReceivedNfseMetadata = z.infer<typeof metadataSchema>
type Party = z.infer<typeof party>

function readParty(node: Element): Party {
  const names = ["CNPJ", "CPF", "NIF", "cNaoNIF"].filter(name => Array.from(node.childNodes).some(n => n.nodeType === 1 && (n as Element).localName === name && (n as Element).namespaceURI === NS))
  if (names.length !== 1) throw Error("party")
  const kind = names[0]!, value = field(node, kind, NS)
  if ((kind === "CNPJ" || kind === "CPF") && (!(kind === "CNPJ" ? /^\d{14}$/ : /^\d{11}$/).test(value) || !validDocument(value, kind === "CNPJ" ? "juridica" : "fisica"))) throw Error("document")
  const hasName = Array.from(node.childNodes).some(n => n.nodeType === 1 && (n as Element).localName === "xNome" && (n as Element).namespaceURI === NS)
  return { kind: kind === "cNaoNIF" ? "no_nif" : kind, value, name: hasName ? field(node, "xNome", NS) : null }
}
const same = (a: Party, b: Party) => a.kind === b.kind && a.value === b.value && a.name === b.name

/** Devolve os metadados conferidos ou `undefined` se não corresponderem ao XML exato. */
export function correlate(result: unknown, xml: string, recipient: string): ReceivedNfseMetadata | undefined {
  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
    const { xml: echoed, ...rest } = result as Record<string, unknown>
    if (echoed !== xml) return undefined
    const parsed = metadataSchema.safeParse(rest)
    if (!parsed.success) return undefined
    const data = { ...parsed.data, verification: { ...parsed.data.verification, correction: parsed.data.verification.correction ?? null } }
    if (data.xmlSha256 !== sha256(xml)) return undefined
    const v = data.verification
    if (!(data.schemaVersion === "1.00" && v.layout === "official_schema_valid" && v.correction === null ||
      data.schemaVersion === "1.01" && v.layout === "local_profile_valid" && v.correction === "nfse-1.01-dps-series-regex-v1")) return undefined
    const root = parseXml(xml, MAX_NFSE_XML)
    if (!root || root.localName !== "NFSe" || root.namespaceURI !== NS || root.getAttribute("versao") !== data.schemaVersion) return undefined
    const info = child(root, "infNFSe", NS), dps = child(info, "DPS", NS)
    if (dps.getAttribute("versao") !== data.schemaVersion || info.getAttribute("Id") !== "NFS" + data.accessKey) return undefined
    const detail = child(dps, "infDPS", NS), actual = readParty(child(detail, "toma", NS))
    const environment = ({ "1": "production", "2": "homologation" } as Record<string, string>)[field(detail, "tpAmb", NS)]
    const service = child(child(detail, "serv", NS), "cServ", NS)
    if (!environment || actual.kind !== "CNPJ" || actual.value !== recipient || !same(actual, data.recipient) ||
      !same(readParty(child(info, "emit", NS)), data.issuer) || !same(readParty(child(detail, "prest", NS)), data.provider) ||
      data.environment !== environment || field(info, "nNFSe", NS) !== data.number || field(info, "dhProc", NS) !== data.processedAt ||
      field(info, "cStat", NS) !== data.processingCode || field(detail, "cLocEmi", NS) !== data.municipalityCode ||
      field(detail, "dhEmi", NS) !== data.issuedAt || field(service, "cTribNac", NS) !== data.serviceCode ||
      field(service, "xDescServ", NS) !== data.description ||
      cents(field(child(child(detail, "valores", NS), "vServPrest", NS), "vServ", NS), 15) !== data.serviceCents ||
      cents(field(child(info, "valores", NS), "vLiq", NS), 15) !== data.netCents) return undefined
    return data
  } catch { return undefined }
}
