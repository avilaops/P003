import { isNumericCnpj, isNumericCpf } from "./brazilian-document.ts";
import { assertNationalNfseLayout } from "./nfse-layout.ts";
import type { NationalNfseLayoutVerification } from "./nfse-layout.ts";

type FiscalObject = Record<string, unknown>;
type Environment = "homologation";

export type PrepareNationalNfseInput = {
  environment: Environment;
  issuedAt: string;
  competence: string;
  applicationVersion: string;
  series: string;
  number: string;
  issuer: { taxId: string; name: string; municipalityCode: string };
  recipient: { taxId: string; name: string };
  service: { municipalityCode: string; nationalTaxCode: string; description: string };
  amount: string;
  taxation: { issTaxation: string; issWithholding: string; totalTaxIndicator: "0" };
};

export type PreparedNationalNfse = {
  id: string;
  version: "1.01";
  environment: Environment;
  amountCents: string;
  xml: string;
  verification: NationalNfseLayoutVerification;
};

export class NationalNfseIssuanceError extends Error {
  code = "invalid_nfse_issuance";
}

const invalid = (message: string): never => { throw new NationalNfseIssuanceError(message); };

function exactObject(value: unknown, fields: readonly string[], label: string): FiscalObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} inválido.`);
  const input = value as FiscalObject;
  if (Object.keys(input).some(key => !fields.includes(key))) return invalid(`Campo desconhecido em ${label}.`);
  return input;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) return invalid(`${label} inválido.`);
  return value;
}

function date(value: unknown, label: string): string {
  const result = text(value, label, 10);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(result)) return invalid(`${label} inválida.`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== result) return invalid(`${label} inválida.`);
  return result;
}

function money(value: unknown): { amount: string; cents: string } {
  const amount = text(value, "Valor do serviço", 18);
  const match = /^(0|[1-9][0-9]{0,14})\.([0-9]{2})$/.exec(amount);
  if (!match) return invalid("Valor do serviço exige centavos exatos e até quinze inteiros.");
  return { amount, cents: (BigInt(match[1]) * 100n + BigInt(match[2])).toString() };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function party(value: unknown, label: string): { tag: "CNPJ" | "CPF"; taxId: string; name: string } {
  const input = exactObject(value, ["taxId", "name"], label);
  const taxId = text(input.taxId, `${label} • CPF/CNPJ`, 14);
  const tag = taxId.length === 14 && isNumericCnpj(taxId) ? "CNPJ" : taxId.length === 11 && isNumericCpf(taxId) ? "CPF" : invalid(`${label} • CPF/CNPJ inválido.`);
  return { tag, taxId, name: text(input.name, `${label} • nome`, 150) };
}

/** Builds an unsigned DPS. Signing and transport are separate operations. */
export async function prepareNationalNfse(value: unknown): Promise<PreparedNationalNfse> {
  const input = exactObject(value, ["environment", "issuedAt", "competence", "applicationVersion", "series", "number", "issuer", "recipient", "service", "amount", "taxation"], "DPS");
  if (input.environment !== "homologation") return invalid("Preparação de NFS-e habilitada somente em homologação.");
  const issuedAt = text(input.issuedAt, "Data de emissão", 25);
  if (!/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:-(?:0\d|1[01]):00|\+(?:0\d|1[0-2]):00)$/.test(issuedAt)) return invalid("Data de emissão inválida.");
  const competence = date(input.competence, "Competência");
  const applicationVersion = text(input.applicationVersion, "Versão do aplicativo", 20);
  const series = text(input.series, "Série DPS", 5);
  const number = text(input.number, "Número DPS", 15);
  if (!/^[0-9]{1,5}$/.test(series) || !/^[1-9][0-9]{0,14}$/.test(number)) return invalid("Série ou número DPS inválido.");

  const issuerInput = exactObject(input.issuer, ["taxId", "name", "municipalityCode"], "prestador");
  const issuer = party({ taxId: issuerInput.taxId, name: issuerInput.name }, "prestador");
  if (issuer.tag !== "CNPJ") return invalid("Prestador MEI exige CNPJ.");
  const issuerMunicipality = text(issuerInput.municipalityCode, "Município do prestador", 7);
  if (issuerMunicipality !== "3543402") return invalid("Emissão MEI restrita a Ribeirão Preto • 3543402.");

  const recipient = party(input.recipient, "tomador");
  const service = exactObject(input.service, ["municipalityCode", "nationalTaxCode", "description"], "serviço");
  const serviceMunicipality = text(service.municipalityCode, "Município da prestação", 7);
  if (!/^\d{7}$/.test(serviceMunicipality)) return invalid("Município da prestação inválido.");
  const nationalTaxCode = text(service.nationalTaxCode, "Código de tributação nacional", 6);
  if (!/^\d{6}$/.test(nationalTaxCode)) return invalid("Código de tributação nacional inválido.");
  const description = text(service.description, "Descrição do serviço", 2000);
  const amount = money(input.amount);

  const taxation = exactObject(input.taxation, ["issTaxation", "issWithholding", "totalTaxIndicator"], "tributação");
  const issTaxation = text(taxation.issTaxation, "Tributação ISSQN", 1);
  const issWithholding = text(taxation.issWithholding, "Retenção ISSQN", 1);
  if (!/^[1-4]$/.test(issTaxation) || !/^[1-3]$/.test(issWithholding) || taxation.totalTaxIndicator !== "0") return invalid("Tributação da DPS inválida.");

  const id = `DPS${issuerMunicipality}2${issuer.taxId}${series.padStart(5, "0")}${number.padStart(15, "0")}`;
  const document = `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infDPS Id="${id}"><tpAmb>2</tpAmb><dhEmi>${issuedAt}</dhEmi><verAplic>${xml(applicationVersion)}</verAplic><serie>${series}</serie><nDPS>${number}</nDPS><dCompet>${competence}</dCompet><tpEmit>1</tpEmit><cLocEmi>${issuerMunicipality}</cLocEmi><prest><CNPJ>${issuer.taxId}</CNPJ><xNome>${xml(issuer.name)}</xNome><regTrib><opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest><toma><${recipient.tag}>${recipient.taxId}</${recipient.tag}><xNome>${xml(recipient.name)}</xNome></toma><serv><locPrest><cLocPrestacao>${serviceMunicipality}</cLocPrestacao></locPrest><cServ><cTribNac>${nationalTaxCode}</cTribNac><xDescServ>${xml(description)}</xDescServ></cServ></serv><valores><vServPrest><vServ>${amount.amount}</vServ></vServPrest><trib><tribMun><tribISSQN>${issTaxation}</tribISSQN><tpRetISSQN>${issWithholding}</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores></infDPS></DPS>`;
  const verification = await assertNationalNfseLayout(document, "1.01", "DPS");
  return { id, version: "1.01", environment: "homologation", amountCents: amount.cents, xml: document, verification };
}
