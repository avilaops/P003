import { createHash, randomUUID } from "node:crypto"

import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record, remember, replay } from "../../platform/commands.js"
import { stringifyJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import type { CertificateMaterial, FiscalEngineResult, OutgoingNfseEngine } from "./engine-client.js"
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
  const company = (await context.client.query<{ tax_id: string; legal_name: string }>("SELECT tax_id,legal_name FROM tenants WHERE id=$1", [context.tenantId])).rows[0]
  if (!company || !/^\d{14}$/.test(company.tax_id)) throw new Problem(409, "company_incomplete", "Cadastro da empresa incompleto para emissão fiscal")
  const sequence = (await context.client.query<{ number: string | number }>("INSERT INTO fiscal_outgoing_nfse_sequences(tenant_id,series,next_number) VALUES($1,1,2) ON CONFLICT(tenant_id,series) DO UPDATE SET next_number=fiscal_outgoing_nfse_sequences.next_number+1 RETURNING next_number-1 AS number", [context.tenantId])).rows[0]
  if (!sequence) throw new Problem(500, "internal_error", "Erro interno")
  const prepared = await engine.prepare({
    environment: "homologation", issuedAt: fiscalTimestamp(), competence: input.competenceDate, applicationVersion: "erp-ts-0.1", series: "1", number: String(sequence.number),
    issuer: { taxId: company.tax_id, name: company.legal_name, municipalityCode: "3543402" },
    recipient: { taxId: input.customer.taxId, name: input.customer.name },
    service: { municipalityCode: "3543402", nationalTaxCode: input.serviceCode, description: input.description },
    amount: input.amount, taxation: { issTaxation: "1", issWithholding: "1", totalTaxIndicator: "0" },
  })
  if (typeof prepared.id !== "string" || !/^DPS\d{42}$/.test(prepared.id)) throw new Problem(502, "invalid_fiscal_engine_response", "Motor fiscal retornou uma DPS inválida")
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
