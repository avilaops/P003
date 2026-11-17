import { gzipSync, gunzipSync } from "node:zlib";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { ICP_BRASIL_ROOT_V10 } from "./icp-brasil.ts";
import { readCertificate } from "./certificate.ts";
import { assertNationalNfseLayout } from "./nfse-layout.ts";
import type { PreparedNationalNfse } from "./nfse-issuance.ts";
import { signNationalNfseDps, signNationalNfseEvent, signingKeyOf } from "./sign.ts";

export type SefinTransportRequest = {
  method: "GET" | "POST";
  url: string;
  body?: string;
  timeoutMs: 45_000;
  certificate: { pfx: Buffer; passphrase: string };
};
export type SefinTransportResponse = { status: number; body: string };
export type SefinTransport = (request: SefinTransportRequest) => Promise<SefinTransportResponse>;

type CertificateInput = { pkcs12Base64: string; password: string };
type IssueResult = {
  status: "authorized" | "rejected" | "uncertain" | "pending" | "cancelled";
  accessKey?: string;
  xml?: string;
  code?: string;
  reason: string;
};

export class SefinNfseError extends Error {
  code: string;
  constructor(message: string, code = "invalid_nfse_transport") { super(message); this.code = code; }
}

const blocked = (message: string, code?: string): never => { throw new SefinNfseError(message, code); };
const uncertain = (): IssueResult => ({ status: "uncertain", code: "sefin_unavailable", reason: "Operação fiscal não confirmada; consulte a DPS antes de repetir." });
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function certificateMaterial(input: CertificateInput, issuerTaxId: string) {
  if (!input || typeof input !== "object" || typeof input.pkcs12Base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.pkcs12Base64) || typeof input.password !== "string" || input.password.length > 1024) return blocked("Certificado A1 inválido.", "certificate_invalid");
  const pfx = Buffer.from(input.pkcs12Base64, "base64");
  const info = readCertificate(pfx, input.password);
  if (info.holderCnpj !== issuerTaxId || info.validFrom.valueOf() > Date.now() || info.validUntil.valueOf() <= Date.now()) return blocked("Certificado A1 vencido ou incompatível com o CNPJ do prestador.", "certificate_invalid");
  return { pfx, passphrase: input.password };
}

const baseUrl = (environment: PreparedNationalNfse["environment"]) => environment === "homologation"
  ? "https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional"
  : blocked("Produção de NFS-e permanece desabilitada até homologação explícita.", "nfse_production_disabled");

export const sendToSefin: SefinTransport = request => new Promise((resolve, reject) => {
  const target = new URL(request.url);
  const roots = process.env.NFSE_CA_FILE;
  const call = httpsRequest({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    path: `${target.pathname}${target.search}`,
    method: request.method,
    headers: request.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(request.body), Accept: "application/json" } : { Accept: "application/json" },
    pfx: request.certificate.pfx,
    passphrase: request.certificate.passphrase,
    ca: roots ? readFileSync(roots) : ICP_BRASIL_ROOT_V10,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    timeout: request.timeoutMs,
  }, response => {
    const chunks: Buffer[] = [];
    let length = 0;
    response.on("data", chunk => {
      length += chunk.length;
      if (length > 2_097_152) response.destroy(new Error("Resposta SEFIN acima do limite."));
      else chunks.push(Buffer.from(chunk));
    });
    response.on("end", () => resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
  });
  call.on("timeout", () => call.destroy(new DOMException("SEFIN timeout", "TimeoutError")));
  call.on("error", reject);
  if (request.body) call.write(request.body);
  call.end();
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return blocked("Resposta inválida da SEFIN Nacional.", "invalid_sefin_response");
  return value as Record<string, unknown>;
}

function decodeXml(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_796_204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return blocked("XML autorizado ausente na resposta SEFIN.", "invalid_sefin_response");
  try {
    const xml = gunzipSync(Buffer.from(value, "base64"), { maxOutputLength: 1_048_576 }).toString("utf8");
    if (!xml.startsWith("<?xml") || Buffer.from(xml, "utf8").toString("utf8") !== xml) return blocked("XML autorizado inválido na resposta SEFIN.", "invalid_sefin_response");
    return xml;
  } catch { return blocked("XML autorizado inválido na resposta SEFIN.", "invalid_sefin_response"); }
}

export async function issueNationalNfse(input: { prepared: PreparedNationalNfse; issuerTaxId: string; certificate: CertificateInput }, transport: SefinTransport = sendToSefin): Promise<IssueResult> {
  if (!input || typeof input !== "object" || !input.prepared || !/^\d{14}$/.test(input.issuerTaxId) || input.prepared.id.slice(11, 25) !== input.issuerTaxId) return blocked("Prestador diverge da DPS.");
  const endpoint = `${baseUrl(input.prepared.environment)}/nfse`;
  const certificate = certificateMaterial(input.certificate, input.issuerTaxId);
  const signedXml = signNationalNfseDps(input.prepared.xml, signingKeyOf(certificate.pfx, certificate.passphrase));
  await assertNationalNfseLayout(signedXml, "1.01", "DPS");
  const body = JSON.stringify({ dpsXmlGZipB64: gzipSync(Buffer.from(signedXml, "utf8")).toString("base64") });
  let response: SefinTransportResponse;
  try { response = await transport({ method: "POST", url: endpoint, body, timeoutMs: 45_000, certificate }); }
  catch { return uncertain(); }
  if (response.status >= 500 || response.status === 408 || response.status === 429) return uncertain();
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(response.body)); } catch { return response.status >= 400 ? { status: "rejected", code: "sefin_rejected", reason: "DPS rejeitada pela SEFIN Nacional." } : uncertain(); }
  if (response.status !== 201) {
    const errors = Array.isArray(payload.erros) ? payload.erros.map(object) : [];
    const first = errors[0];
    const code = typeof first?.codigo === "string" ? first.codigo.slice(0, 40) : "sefin_rejected";
    const reason = typeof first?.descricao === "string" && first.descricao.length <= 500 ? first.descricao.replace(/[<>]/g, "") : "DPS rejeitada pela SEFIN Nacional.";
    return { status: "rejected", code, reason };
  }
  if (payload.tipoAmbiente !== 2 || payload.idDps !== input.prepared.id || typeof payload.chaveAcesso !== "string" || !/^\d{50}$/.test(payload.chaveAcesso)) return blocked("Resposta SEFIN não corresponde à DPS enviada.", "invalid_sefin_response");
  const xml = decodeXml(payload.nfseXmlGZipB64);
  await assertNationalNfseLayout(xml, "1.01");
  if (!xml.includes(`Id="NFS${payload.chaveAcesso}"`)) return blocked("XML autorizado diverge da chave retornada.", "invalid_sefin_response");
  return { status: "authorized", accessKey: payload.chaveAcesso, xml, reason: "NFS-e autorizada." };
}

export async function consultNationalNfse(input: { dpsId: string; issuerTaxId: string; certificate: CertificateInput }, transport: SefinTransport = sendToSefin): Promise<IssueResult> {
  if (!input || typeof input !== "object" || !/^DPS\d{42}$/.test(input.dpsId) || !/^\d{14}$/.test(input.issuerTaxId) || input.dpsId.slice(11, 25) !== input.issuerTaxId) return blocked("Prestador diverge da DPS.");
  const certificate = certificateMaterial(input.certificate, input.issuerTaxId);
  const endpoint = baseUrl("homologation");
  let dps: SefinTransportResponse;
  try { dps = await transport({ method: "GET", url: `${endpoint}/dps/${input.dpsId}`, timeoutMs: 45_000, certificate }); }
  catch { return uncertain(); }
  if (dps.status === 404) return { status: "pending", reason: "NFS-e ainda não localizada para a DPS." };
  if (dps.status >= 500 || dps.status === 408 || dps.status === 429) return uncertain();
  if (dps.status !== 200) return { status: "rejected", code: "sefin_consult_rejected", reason: "Consulta da DPS rejeitada pela SEFIN Nacional." };
  let accessKey: string;
  try {
    const payload = object(JSON.parse(dps.body));
    accessKey = typeof payload.chaveAcesso === "string" ? payload.chaveAcesso : "";
  } catch { return uncertain(); }
  if (!/^\d{50}$/.test(accessKey)) return blocked("Chave inválida na consulta da DPS.", "invalid_sefin_response");
  let response: SefinTransportResponse;
  try { response = await transport({ method: "GET", url: `${endpoint}/nfse/${accessKey}`, timeoutMs: 45_000, certificate }); }
  catch { return uncertain(); }
  if (response.status >= 500 || response.status === 408 || response.status === 429) return uncertain();
  if (response.status === 404) return { status: "pending", accessKey, reason: "NFS-e ainda não disponível para consulta." };
  if (response.status !== 200) return { status: "rejected", accessKey, code: "sefin_consult_rejected", reason: "Consulta da NFS-e rejeitada pela SEFIN Nacional." };
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(response.body)); } catch { return uncertain(); }
  if (payload.tipoAmbiente !== 2 || payload.chaveAcesso !== accessKey) return blocked("Resposta da consulta diverge da DPS.", "invalid_sefin_response");
  const xml = decodeXml(payload.nfseXmlGZipB64);
  await assertNationalNfseLayout(xml, "1.01");
  if (!xml.includes(`Id="NFS${accessKey}"`)) return blocked("XML consultado diverge da chave.", "invalid_sefin_response");
  return { status: "authorized", accessKey, xml, reason: "NFS-e autorizada." };
}

export async function cancelNationalNfse(input: { accessKey: string; issuerTaxId: string; certificate: CertificateInput; occurredAt: string; applicationVersion: string; reasonCode: "1" | "2" | "9"; reason: string }, transport: SefinTransport = sendToSefin): Promise<IssueResult> {
  if (!input || typeof input !== "object" || !/^\d{50}$/.test(input.accessKey) || !/^\d{14}$/.test(input.issuerTaxId)) return blocked("Chave ou prestador inválido para cancelamento.");
  if (typeof input.occurredAt !== "string" || !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:-(?:0\d|1[01]):00|\+(?:0\d|1[0-2]):00)$/.test(input.occurredAt)) return blocked("Data do cancelamento inválida.");
  if (typeof input.applicationVersion !== "string" || !input.applicationVersion || input.applicationVersion.length > 20 || !["1", "2", "9"].includes(input.reasonCode) || typeof input.reason !== "string" || input.reason.trim().length < 15 || input.reason.length > 255 || /[\x00-\x1f]/.test(input.reason)) return blocked("Motivo do cancelamento inválido.");
  const certificate = certificateMaterial(input.certificate, input.issuerTaxId);
  const id = `PRE${input.accessKey}101101`;
  const unsigned = `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infPedReg Id="${id}"><tpAmb>2</tpAmb><verAplic>${escapeXml(input.applicationVersion)}</verAplic><dhEvento>${input.occurredAt}</dhEvento><CNPJAutor>${input.issuerTaxId}</CNPJAutor><chNFSe>${input.accessKey}</chNFSe><e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>${input.reasonCode}</cMotivo><xMotivo>${escapeXml(input.reason)}</xMotivo></e101101></infPedReg></pedRegEvento>`;
  const signed = signNationalNfseEvent(unsigned, signingKeyOf(certificate.pfx, certificate.passphrase));
  const body = JSON.stringify({ pedidoRegistroEventoXmlGZipB64: gzipSync(Buffer.from(signed, "utf8")).toString("base64") });
  let response: SefinTransportResponse;
  try { response = await transport({ method: "POST", url: `${baseUrl("homologation")}/nfse/${input.accessKey}/eventos`, body, timeoutMs: 45_000, certificate }); }
  catch { return uncertain(); }
  if (response.status >= 500 || response.status === 408 || response.status === 429) return uncertain();
  if (response.status !== 201) {
    let code = "sefin_cancel_rejected", reason = "Cancelamento rejeitado pela SEFIN Nacional.";
    try {
      const payload = object(JSON.parse(response.body));
      const error = object(payload.erro);
      if (typeof error.codigo === "string") code = error.codigo.slice(0, 40);
      if (typeof error.descricao === "string" && error.descricao.length <= 500) reason = error.descricao.replace(/[<>]/g, "");
    } catch { /* keep safe generic rejection */ }
    return { status: "rejected", accessKey: input.accessKey, code, reason };
  }
  let payload: Record<string, unknown>;
  try { payload = object(JSON.parse(response.body)); } catch { return uncertain(); }
  if (payload.tipoAmbiente !== 2 || typeof payload.eventoXmlGZipB64 !== "string") return blocked("Resposta de cancelamento inválida.", "invalid_sefin_response");
  try {
    const eventXml = gunzipSync(Buffer.from(payload.eventoXmlGZipB64, "base64"), { maxOutputLength: 1_048_576 }).toString("utf8");
    if (!eventXml) return blocked("Evento de cancelamento vazio.", "invalid_sefin_response");
  } catch { return blocked("Evento de cancelamento inválido.", "invalid_sefin_response"); }
  return { status: "cancelled", accessKey: input.accessKey, reason: "Cancelamento registrado." };
}
