// NFS-e nacional sintética de homologação (tpAmb=2), só para testes. Assinatura deliberadamente inválida:
// o motor fiscal é simulado e a API não confia na assinatura. Nunca use XML real de empresa aqui.
import { createHash } from "node:crypto"

export const NFSE_RECIPIENT = "04252011000110"
export const NFSE_ISSUER = "19131243000197"

/** XML nacional e o resultado que o motor `inspect-nfse` devolveria para ele. */
export function nfseFixture({ number = "1", amount = "123.45", description = "Inspeção offline — sem transmissão." }: { number?: string; amount?: string; description?: string } = {}) {
  const accessKey = `3550308${1}${2}${NFSE_ISSUER}${"1".padStart(13, "0")}2611${number.padStart(9, "0")}0`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${accessKey}">` +
    `<xLocEmi>São Paulo</xLocEmi><nNFSe>${number}</nNFSe><cStat>100</cStat><dhProc>2026-11-03T10:00:01-03:00</dhProc>` +
    `<emit><CNPJ>${NFSE_ISSUER}</CNPJ><xNome>Serviços &amp; Companhia</xNome></emit><valores><vLiq>123.00</vLiq></valores>` +
    `<DPS versao="1.01"><infDPS Id="DPS35503082${NFSE_ISSUER}00001000000000000001"><tpAmb>2</tpAmb><dhEmi>2026-11-03T10:00:00-03:00</dhEmi><cLocEmi>3550308</cLocEmi>` +
    `<prest><CNPJ>${NFSE_ISSUER}</CNPJ><xNome>Prestador sintético</xNome></prest><toma><CNPJ>${NFSE_RECIPIENT}</CNPJ><xNome>Tomador sintético</xNome></toma>` +
    `<serv><cServ><cTribNac>010101</cTribNac><xDescServ>${description}</xDescServ></cServ></serv><valores><vServPrest><vServ>${amount}</vServ></vServPrest></valores>` +
    `</infDPS></DPS></infNFSe><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignatureValue>AA==</SignatureValue></Signature></NFSe>`
  const inspection = {
    source: "nfse_nacional", schemaVersion: "1.01", accessKey, environment: "homologation", number, municipalityCode: "3550308",
    issuedAt: "2026-11-03T10:00:00-03:00", processedAt: "2026-11-03T10:00:01-03:00", processingCode: "100",
    issuer: { kind: "CNPJ", value: NFSE_ISSUER, name: "Serviços & Companhia" }, provider: { kind: "CNPJ", value: NFSE_ISSUER, name: "Prestador sintético" },
    recipient: { kind: "CNPJ", value: NFSE_RECIPIENT, name: "Tomador sintético" }, serviceCode: "010101", description,
    serviceCents: String(Math.round(Number(amount) * 100)), netCents: "12300", xml, xmlSha256: createHash("sha256").update(xml).digest("hex"),
    verification: { layout: "local_profile_valid", correction: "nfse-1.01-dps-series-regex-v1", signature: "not_verified", currentStatus: "not_queried" },
  }
  return { accessKey, xml, inspection }
}
