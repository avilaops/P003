// CT-e sintético de homologação (tpAmb=2), só para testes. Participantes, protocolo e assinatura são fictícios:
// a assinatura não é válida e o motor fiscal é simulado. Nunca use XML real de empresa aqui.
import { createHash } from "node:crypto"
import { checkDigit } from "../../../src/modules/fiscal-workspace/emission.js"

export const CTE_COMPANY = "04252011000110"
export const CTE_CARRIER = "11222333000181"
const OTHER = "48240052000161"
const NFE_PARTIAL = "3526101234567800019555001000000123148291736"
export const CTE_NFE = NFE_PARTIAL + checkDigit(NFE_PARTIAL)
const NS = "http://www.portalfiscal.inf.br/cte"
const DIGEST = "ZmljdGljaW8tZGlnZXN0LWN0ZQ=="
const address = "<xLgr>Rua de Teste</xLgr><nro>100</nro><xBairro>Centro</xBairro><cMun>3550308</cMun><xMun>SAO PAULO</xMun><UF>SP</UF>"
const person = (tag: string, cnpj: string, addressTag: string) => `<${tag}><CNPJ>${cnpj}</CNPJ><xNome>PARTICIPANTE FICTICIO</xNome><${addressTag}>${address}</${addressTag}></${tag}>`

/** XML `cteProc` 4.00 e o resultado que o motor `inspect-cte` devolveria para ele. */
export function cteFixture({ amount = "150.01", number = "123", carrier = CTE_CARRIER }: { amount?: string; number?: string; carrier?: string } = {}) {
  const partial = `352610${carrier}57001${number.padStart(9, "0")}148291736`
  const accessKey = partial + checkDigit(partial)
  const info = `<infCte versao="4.00" Id="CTe${accessKey}"><ide><cUF>35</cUF><cCT>48291736</cCT><CFOP>5353</CFOP><natOp>PRESTACAO FICTICIA</natOp><mod>57</mod><serie>1</serie><nCT>${number}</nCT>` +
    `<dhEmi>2026-10-02T23:30:00-03:00</dhEmi><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${accessKey[43]}</cDV><tpAmb>2</tpAmb><tpCTe>0</tpCTe><procEmi>0</procEmi><verProc>TESTE</verProc>` +
    `<modal>01</modal><tpServ>0</tpServ><toma3><toma>0</toma></toma3></ide>` +
    `<emit><CNPJ>${carrier}</CNPJ><IE>110042490114</IE><xNome>TRANSPORTADORA FICTICIA</xNome><enderEmit>${address}</enderEmit><CRT>1</CRT></emit>` +
    person("rem", CTE_COMPANY, "enderReme") + person("exped", OTHER, "enderExped") + person("receb", OTHER, "enderReceb") + person("dest", OTHER, "enderDest") +
    `<vPrest><vTPrest>${amount}</vTPrest><vRec>${amount}</vRec></vPrest><infCTeNorm><infDoc><infNFe><chave>${CTE_NFE}</chave></infNFe></infDoc>` +
    `<infModal versaoModal="4.00"><rodo><RNTRC>12345678</RNTRC></rodo></infModal></infCTeNorm></infCte>`
  const signature = `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="#CTe${accessKey}"><DigestValue>${DIGEST}</DigestValue></Reference></SignedInfo><SignatureValue>AA==</SignatureValue></Signature>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><cteProc xmlns="${NS}" versao="4.00"><CTe xmlns="${NS}">${info}${signature}</CTe>` +
    `<protCTe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>TESTE</verAplic><chCTe>${accessKey}</chCTe><dhRecbto>2026-10-03T00:00:00-03:00</dhRecbto>` +
    `<nProt>135260000000123</nProt><digVal>${DIGEST}</digVal><cStat>100</cStat><xMotivo>Autorizado o uso do CT-e</xMotivo></infProt></protCTe></cteProc>`
  const other = { kind: "CNPJ", value: OTHER, name: "PARTICIPANTE FICTICIO" }, company = { kind: "CNPJ", value: CTE_COMPANY, name: "PARTICIPANTE FICTICIO" }
  const cents = (value: string) => String(Math.round(Number(value) * 100))
  const inspection = {
    source: "cte_distribution", schemaVersion: "4.00", profile: "PL_CTe_400_NT2026.004_RTC_1.00_2026-10-16", environment: "homologation", companyTaxId: CTE_COMPANY,
    accessKey, number, series: "1", issuedAt: "2026-10-02T23:30:00-03:00", modal: "01", documentType: "0",
    carrier: { kind: "CNPJ", value: carrier, name: "TRANSPORTADORA FICTICIA" }, sender: company, dispatcher: other, receiver: other, recipient: other, taker: company,
    takerRole: "sender", companyRoles: carrier === CTE_COMPANY ? ["carrier", "sender", "taker"] : ["sender", "taker"], serviceCents: cents(amount), receivableCents: cents(amount),
    nfeReferences: [CTE_NFE], cteReferences: [], protocol: { code: "100", number: "135260000000123", receivedAt: "2026-10-03T00:00:00-03:00", digest: DIGEST },
    xml, xmlSha256: createHash("sha256").update(xml).digest("hex"),
    verification: { layout: "official_schema_valid", signature: "consistent", certificateTrust: "not_verified", currentStatus: "not_queried", protocolAuthenticity: "not_verified" },
  }
  return { accessKey, xml, inspection }
}

export const cteEventXml = `<procEventoCTe xmlns="${NS}" versao="4.00"><eventoCTe versao="4.00"><infEvento Id="ID1101113526101122233300018157001000000123148291736301"/></eventoCTe></procEventoCTe>`
