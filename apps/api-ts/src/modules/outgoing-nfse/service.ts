import { createHash, randomUUID } from "node:crypto"

import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record, remember, replay } from "../../platform/commands.js"
import { stringifyJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import type { CertificateMaterial, FiscalEngineResult, InspectedOutgoingNfse, OutgoingNfseEngine } from "./engine-client.js"
import { outgoingNfseCreateSchema, type OutgoingNfseCreateInput } from "./model.js"

export type IssuanceSnapshot = {
  tenantId: string
  data: { id: string; externalId: string; status: string; revision: string | number; accessKey?: string; reason?: string }
}

export type StartedIssuance = {
  replayed?: IssuanceSnapshot
  id?: string
  prepared?: Record<string, unknown>
  issuerTaxId?: string
  certificate?: CertificateMaterial
}

const manualPortal = {
  homologation: "https://www.producaorestrita.nfse.gov.br/EmissorNacional",
  production: "https://www.nfse.gov.br/EmissorNacional",
} as const

async function prepareDps(context: AuthorizedContext, input: OutgoingNfseCreateInput, engine: OutgoingNfseEngine) {
  const company = (await context.client.query<{ tax_id: string; legal_name: string }>("SELECT tax_id,legal_name FROM tenants WHERE id=$1", [context.tenantId])).rows[0]
  if (!company || !/^\d{14}$/.test(company.tax_id)) throw new Problem(409, "company_incomplete", "Cadastro da empresa incompleto para emissão fiscal")
  const sequence = (await context.client.query<{ number: string | number }>("INSERT INTO fiscal_outgoing_nfse_sequences(tenant_id,series,next_number) VALUES($1,1,2) ON CONFLICT(tenant_id,series) DO UPDATE SET next_number=fiscal_outgoing_nfse_sequences.next_number+1 RETURNING next_number-1 AS number", [context.tenantId])).rows[0]
  if (!sequence) throw new Problem(500, "internal_error", "Erro interno")
  const prepared = await engine.prepare({
    environment: input.environment, issuedAt: fiscalTimestamp(), competence: input.competenceDate, applicationVersion: "erp-ts-0.1", series: "1", number: String(sequence.number),
    issuer: { taxId: company.tax_id, name: company.legal_name, municipalityCode: "3543402" },
    recipient: { taxId: input.customer.taxId, name: input.customer.name },
    service: { municipalityCode: "3543402", nationalTaxCode: input.serviceCode, description: input.description },
    amount: input.amount, taxation: { issTaxation: "1", issWithholding: "1", totalTaxIndicator: "0" },
  })
  if (typeof prepared.id !== "string" || !/^DPS\d{42}$/.test(prepared.id)) throw new Problem(502, "invalid_fiscal_engine_response", "Motor fiscal retornou uma DPS inválida")
  return { company, prepared }
}

export function fiscalTimestamp() {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())
  return `${parts.replace(" ", "T")}-03:00`
}

export async function startIssuance(
  context: AuthorizedContext,
  headers: Record<string, string | string[] | undefined>,
  key: string,
  rawInput: unknown,
  engine: OutgoingNfseEngine,
  certificateProvider: (context: AuthorizedContext) => Promise<{ issuerTaxId: string; certificate: CertificateMaterial }>,
): Promise<StartedIssuance> {
  requirePermission(context, "fiscal.outgoing_nfse.issue")
  const input = outgoingNfseCreateSchema.parse(rawInput)
  if (input.environment === "production") throw new Problem(409, "nfse_production_disabled", "Produção de NFS-e permanece desabilitada até homologação explícita")
  const previous = await replay(context, key, "fiscal.outgoing_nfse.issue", input) as IssuanceSnapshot | undefined
  if (previous) return { replayed: previous }
  const { company, prepared } = await prepareDps(context, input, engine)
  const material = await certificateProvider(context)
  if (material.issuerTaxId !== company.tax_id) throw new Problem(409, "fiscal_certificate_invalid", "Certificado A1 pertence a outra empresa")
  const id = randomUUID()
  const requestHash = createHash("sha256").update(stringifyJson(input)).digest("hex")
  const processing: IssuanceSnapshot = { tenantId: context.tenantId, data: { id, externalId: input.externalId, status: "processing", revision: 1 } }
  await context.client.query("INSERT INTO fiscal_outgoing_nfse_issuances(tenant_id,id,external_id,environment,status,request_hash,request_snapshot,dps_id,created_by_subject) VALUES($1,$2,$3,$4,'processing',$5,$6,$7,$8)", [context.tenantId, id, input.externalId, input.environment, requestHash, input, prepared.id, context.authSubject])
  await context.client.query("INSERT INTO fiscal_outgoing_nfse_events(tenant_id,id,issuance_id,event_type,from_status,to_status,details,auth_subject) VALUES($1,$2,$3,'fiscal.outgoing_nfse.processing',NULL,'processing',$4,$5)", [context.tenantId, randomUUID(), id, { externalId: input.externalId }, context.authSubject])
  await record(context, headers, "outgoing_nfse", id, "fiscal.outgoing_nfse.processing", { externalId: input.externalId })
  await remember(context, key, "fiscal.outgoing_nfse.issue", input, processing)
  return { id, prepared, issuerTaxId: company.tax_id, certificate: material.certificate }
}

export async function startManualIssuance(
  context: AuthorizedContext,
  headers: Record<string, string | string[] | undefined>,
  key: string,
  rawInput: unknown,
  engine: OutgoingNfseEngine,
): Promise<IssuanceSnapshot & { portalUrl: string; prepared: Record<string, unknown> }> {
  requirePermission(context, "fiscal.outgoing_nfse.issue")
  const input = outgoingNfseCreateSchema.parse(rawInput)
  const scope = "fiscal.outgoing_nfse.manual_prepare"
  const previous = await replay(context, key, scope, input) as (IssuanceSnapshot & { portalUrl: string; prepared: Record<string, unknown> }) | undefined
  if (previous) return previous
  const { prepared } = await prepareDps(context, input, engine)
  const id = randomUUID()
  const snapshot = { ...input, issuanceMode: "manual" as const }
  const requestHash = createHash("sha256").update(stringifyJson(snapshot)).digest("hex")
  await context.client.query("INSERT INTO fiscal_outgoing_nfse_issuances(tenant_id,id,external_id,environment,status,request_hash,request_snapshot,dps_id,created_by_subject) VALUES($1,$2,$3,$4,'pending',$5,$6,$7,$8)", [context.tenantId, id, input.externalId, input.environment, requestHash, snapshot, prepared.id, context.authSubject])
  await context.client.query("INSERT INTO fiscal_outgoing_nfse_events(tenant_id,id,issuance_id,event_type,from_status,to_status,details,auth_subject) VALUES($1,$2,$3,'fiscal.outgoing_nfse.manual_pending',NULL,'pending',$4,$5)", [context.tenantId, randomUUID(), id, { externalId: input.externalId, portalUrl: manualPortal[input.environment] }, context.authSubject])
  const result = { tenantId: context.tenantId, data: { id, externalId: input.externalId, status: "pending", revision: 1, reason: "Emita a NFS-e no Emissor Nacional e importe o XML autorizado." }, portalUrl: manualPortal[input.environment], prepared }
  await record(context, headers, "outgoing_nfse", id, "fiscal.outgoing_nfse.manual_pending", { externalId: input.externalId, environment: input.environment })
  await remember(context, key, scope, input, result)
  return result
}

export async function confirmManualIssuance(
  context: AuthorizedContext,
  headers: Record<string, string | string[] | undefined>,
  key: string,
  id: string,
  xml: string,
  inspected: InspectedOutgoingNfse,
): Promise<IssuanceSnapshot> {
  requirePermission(context, "fiscal.outgoing_nfse.issue")
  const scope = "fiscal.outgoing_nfse.manual_confirm"
  const command = { id, xmlSha256: createHash("sha256").update(xml).digest("hex") }
  const previous = await replay(context, key, scope, command) as IssuanceSnapshot | undefined
  if (previous) return previous
  const row = (await context.client.query<{ external_id: string; environment: string; status: string; revision: string | number; request_snapshot: OutgoingNfseCreateInput & { issuanceMode?: string } }>("SELECT external_id,environment,status,revision,request_snapshot FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
  if (row.status !== "pending" || row.request_snapshot.issuanceMode !== "manual") throw new Problem(409, "domain_conflict", "Somente uma emissão manual pendente aceita confirmação por XML")
  const company = (await context.client.query<{ tax_id: string }>("SELECT tax_id FROM tenants WHERE id=$1", [context.tenantId])).rows[0]
  const expectedCents = (BigInt(row.request_snapshot.amount.replace(".", ""))).toString()
  if (!company || inspected.provider.kind !== "CNPJ" || inspected.provider.value !== company.tax_id
    || inspected.environment !== row.environment || inspected.recipient.value !== row.request_snapshot.customer.taxId
    || inspected.serviceCents !== expectedCents || inspected.serviceCode !== row.request_snapshot.serviceCode
    || inspected.description.trim() !== row.request_snapshot.description.trim() || inspected.xml !== xml) {
    throw new Problem(422, "nfse_manual_mismatch", "O XML não corresponde à empresa, ao cliente, ao valor ou ao serviço preparados")
  }
  const revision = BigInt(row.revision) + 1n
  await context.client.query("UPDATE fiscal_outgoing_nfse_issuances SET status='authorized',access_key=$3,nfse_number=$4,issued_at=$5,xml=$6,xml_sha256=$7,error_code=NULL,error_message=NULL,revision=$8 WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, inspected.accessKey, inspected.number, inspected.issuedAt, xml, inspected.xmlSha256, revision.toString()])
  await context.client.query("INSERT INTO fiscal_outgoing_nfse_events(tenant_id,id,issuance_id,event_type,from_status,to_status,details,auth_subject) VALUES($1,$2,$3,'fiscal.outgoing_nfse.manual_authorized','pending','authorized',$4,$5)", [context.tenantId, randomUUID(), id, { accessKey: inspected.accessKey, number: inspected.number, xmlSha256: inspected.xmlSha256 }, context.authSubject])
  const result: IssuanceSnapshot = { tenantId: context.tenantId, data: { id, externalId: row.external_id, status: "authorized", revision: revision.toString(), accessKey: inspected.accessKey, reason: "NFS-e emitida no Emissor Nacional e validada pelo ERP." } }
  await record(context, headers, "outgoing_nfse", id, "fiscal.outgoing_nfse.manual_authorized", { revision: revision.toString(), accessKey: inspected.accessKey })
  await remember(context, key, scope, command, result)
  return result
}

export async function finishIssuance(context: AuthorizedContext, headers: Record<string, string | string[] | undefined>, id: string, key: string, result: FiscalEngineResult): Promise<IssuanceSnapshot> {
  requirePermission(context, "fiscal.outgoing_nfse.issue")
  const current = (await context.client.query<{ external_id: string; status: string; revision: string | number }>("SELECT external_id,status,revision FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
  if (!current) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
  if (current.status !== "processing") throw new Problem(409, "domain_conflict", "Emissão fiscal já foi finalizada ou exige consulta")
  if (!["authorized", "rejected", "uncertain"].includes(result.status) || result.status === "authorized" && (!result.accessKey || !result.xml)) {
    throw new Problem(502, "invalid_fiscal_engine_response", "Motor fiscal retornou um resultado de emissão inválido")
  }
  const xmlHash = result.xml ? createHash("sha256").update(result.xml).digest("hex") : null
  const revision = BigInt(current.revision) + 1n
  await context.client.query("UPDATE fiscal_outgoing_nfse_issuances SET status=$3,access_key=$4,xml=$5,xml_sha256=$6,error_code=$7,error_message=$8,issued_at=CASE WHEN $3='authorized' THEN clock_timestamp() ELSE issued_at END,revision=$9 WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, result.status, result.accessKey ?? null, result.xml ?? null, xmlHash, result.code ?? null, result.reason, revision.toString()])
  await context.client.query("INSERT INTO fiscal_outgoing_nfse_events(tenant_id,id,issuance_id,event_type,from_status,to_status,details,auth_subject) VALUES($1,$2,$3,$4,'processing',$5,$6,$7)", [context.tenantId, randomUUID(), id, `fiscal.outgoing_nfse.${result.status}`, result.status, { code: result.code ?? null, reason: result.reason }, context.authSubject])
  const snapshot: IssuanceSnapshot = { tenantId: context.tenantId, data: { id, externalId: current.external_id, status: result.status, revision: revision.toString(), ...(result.accessKey ? { accessKey: result.accessKey } : {}), reason: result.reason } }
  await context.client.query("UPDATE domain_commands SET result=$4 WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.authSubject, key, snapshot])
  await record(context, headers, "outgoing_nfse", id, `fiscal.outgoing_nfse.${result.status}`, { revision: revision.toString(), reason: result.reason })
  return snapshot
}

export function parseIssuanceInput(input: unknown): OutgoingNfseCreateInput {
  const parsed = outgoingNfseCreateSchema.safeParse(input)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Dados da NFS-e inválidos ou campos desconhecidos")
  return parsed.data
}
