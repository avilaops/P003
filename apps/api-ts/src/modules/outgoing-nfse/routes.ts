import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { authorizeServiceRequest } from "../../platform/service-auth.js"
import type { CertificateMaterial, FiscalEngineResult, OutgoingNfseEngine } from "./engine-client.js"
import { confirmManualIssuance, finishIssuance, fiscalTimestamp, parseIssuanceInput, startIssuance, startManualIssuance, type IssuanceSnapshot } from "./service.js"

export type OutgoingNfseDependencies = {
  engine: OutgoingNfseEngine
  certificateProvider(context: AuthorizedContext): Promise<{ issuerTaxId: string; certificate: CertificateMaterial }>
}

const idSchema = z.string().uuid()
const cancelSchema = z.object({ reasonCode: z.enum(["1", "2", "9"]), reason: z.string().trim().min(15).max(255) }).strict()
const manualConfirmationSchema = z.object({ xml: z.string().min(1).max(1_048_576) }).strict()
const unavailable = () => { throw new Problem(503, "fiscal_engine_unavailable", "Emissão de NFS-e não configurada") }

export function registerOutgoingNfseRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  const authorize = <T>(request: Parameters<typeof authorizeServiceRequest<T>>[0], operation: Parameters<typeof authorizeServiceRequest<T>>[2]) => authorizeServiceRequest(request, dependencies.pool, operation)
  app.post("/api/v1/integrations/nfse/issuances", async (request, reply) => {
    const fiscal = dependencies.outgoingNfse ?? unavailable()
    const input = parseIssuanceInput(request.body)
    const key = commandKey(request.headers["idempotency-key"])
    const started = await authorize(request, context => startIssuance(context, request.headers, key, input, fiscal.engine, fiscal.certificateProvider))
    if (started.replayed) return reply.header("idempotency-replayed", "true").header("cache-control", "no-store").send(started.replayed)
    let result: FiscalEngineResult
    try {
      result = await fiscal.engine.issue({ prepared: started.prepared!, issuerTaxId: started.issuerTaxId!, certificate: started.certificate! })
    } catch {
      result = { status: "uncertain", code: "fiscal_operation_uncertain", reason: "Operação fiscal não confirmada; consulte a situação antes de repetir" }
    }
    const body = await authorize(request, context => finishIssuance(context, request.headers, started.id!, key, result))
    return reply.code(result.status === "uncertain" || result.status === "pending" ? 202 : 200).header("cache-control", "no-store").send(body)
  })

  app.post("/api/v1/integrations/nfse/manual-issuances", async (request, reply) => {
    const fiscal = dependencies.outgoingNfse ?? unavailable()
    const input = parseIssuanceInput(request.body)
    const key = commandKey(request.headers["idempotency-key"])
    const body = await authorize(request, context => startManualIssuance(context, request.headers, key, input, fiscal.engine))
    return reply.code(201).header("cache-control", "no-store").send(body)
  })

  app.get("/api/v1/integrations/nfse/issuances/:id", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id?: string }).id)
    if (!id.success) throw new Problem(400, "invalid_id", "Identificador da emissão inválido")
    const body = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.read")
      const row = (await context.client.query<Record<string, unknown>>("SELECT id,external_id AS \"externalId\",status,revision,access_key AS \"accessKey\",error_message AS reason,created_at AS \"createdAt\",updated_at AS \"updatedAt\" FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2", [context.tenantId, id.data])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
      return { tenantId: context.tenantId, data: row }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get("/api/v1/integrations/nfse/issuances/:id/xml", async (request, reply) => {
    const id = idSchema.safeParse((request.params as { id?: string }).id)
    if (!id.success) throw new Problem(400, "invalid_id", "Identificador da emissão inválido")
    const xml = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.read")
      const row = (await context.client.query<{ xml: string | null }>("SELECT xml FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2", [context.tenantId, id.data])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
      if (!row.xml) throw new Problem(409, "nfse_xml_unavailable", "XML autorizado ainda não está disponível")
      return row.xml
    })
    return reply.header("content-type", "application/xml; charset=utf-8").header("cache-control", "no-store").send(xml)
  })

  app.post("/api/v1/integrations/nfse/issuances/:id/manual-confirm", async (request, reply) => {
    const fiscal = dependencies.outgoingNfse ?? unavailable()
    const id = idSchema.safeParse((request.params as { id?: string }).id)
    const input = manualConfirmationSchema.safeParse(request.body)
    if (!id.success || !input.success) throw new Problem(422, "invalid_input", "Confirmação manual de NFS-e inválida")
    const key = commandKey(request.headers["idempotency-key"])
    const prepared = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.issue")
      const row = (await context.client.query<{ status: string; request_snapshot: { issuanceMode?: string } }>("SELECT status,request_snapshot FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2", [context.tenantId, id.data])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
      if (row.status !== "pending" || row.request_snapshot.issuanceMode !== "manual") throw new Problem(409, "domain_conflict", "Somente uma emissão manual pendente aceita confirmação por XML")
      const company = (await context.client.query<{ tax_id: string }>("SELECT tax_id FROM tenants WHERE id=$1", [context.tenantId])).rows[0]
      if (!company) throw new Problem(409, "company_incomplete", "Cadastro da empresa incompleto para emissão fiscal")
      return company.tax_id
    })
    const inspected = await fiscal.engine.inspectOutgoing({ xml: input.data.xml, providerTaxId: prepared })
    const body = await authorize(request, context => confirmManualIssuance(context, request.headers, key, id.data, input.data.xml, inspected))
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post("/api/v1/integrations/nfse/issuances/:id/reconcile", async (request, reply) => {
    const fiscal = dependencies.outgoingNfse ?? unavailable()
    const id = idSchema.safeParse((request.params as { id?: string }).id)
    if (!id.success) throw new Problem(400, "invalid_id", "Identificador da emissão inválido")
    const key = commandKey(request.headers["idempotency-key"])
    const prepared = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.issue")
      const prior = await replay(context, key, "fiscal.outgoing_nfse.reconcile", { id: id.data }) as IssuanceSnapshot | undefined
      if (prior) return { replayed: prior }
      const row = (await context.client.query<{ external_id: string; status: string; dps_id: string; revision: string | number }>("SELECT external_id,status,dps_id,revision FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id.data])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
      if (!["processing", "uncertain"].includes(row.status)) throw new Problem(409, "domain_conflict", "Somente emissão pendente ou incerta pode ser reconciliada")
      const material = await fiscal.certificateProvider(context)
      const processing: IssuanceSnapshot = { tenantId: context.tenantId, data: { id: id.data, externalId: row.external_id, status: row.status, revision: row.revision, reason: "Consulta em processamento" } }
      await remember(context, key, "fiscal.outgoing_nfse.reconcile", { id: id.data }, processing)
      return { row, material }
    })
    if ("replayed" in prepared) return reply.header("idempotency-replayed", "true").send(prepared.replayed)
    let result: FiscalEngineResult
    try {
      result = await fiscal.engine.consult({ dpsId: prepared.row.dps_id, issuerTaxId: prepared.material.issuerTaxId, certificate: prepared.material.certificate })
    } catch {
      result = { status: "uncertain", code: "fiscal_operation_uncertain", reason: "Consulta fiscal não confirmada; tente novamente mais tarde" }
    }
    const normalized = result.status === "pending" ? { ...result, status: "uncertain" as const } : result
    if (!["authorized", "rejected", "uncertain"].includes(normalized.status) || normalized.status === "authorized" && (!normalized.accessKey || !normalized.xml)) throw new Problem(502, "invalid_fiscal_engine_response", "Motor fiscal retornou uma consulta inválida")
    const body = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.issue")
      const revision = BigInt(prepared.row.revision) + 1n
      const xmlHash = normalized.xml ? createHash("sha256").update(normalized.xml).digest("hex") : null
      await context.client.query("UPDATE fiscal_outgoing_nfse_issuances SET status=$3,access_key=$4,xml=$5,xml_sha256=$6,error_code=$7,error_message=$8,issued_at=CASE WHEN $3='authorized' THEN clock_timestamp() ELSE issued_at END,revision=$9 WHERE tenant_id=$1 AND id=$2 AND status IN ('processing','uncertain')", [context.tenantId, id.data, normalized.status, normalized.accessKey ?? null, normalized.xml ?? null, xmlHash, normalized.code ?? null, normalized.reason, revision.toString()])
      await context.client.query("INSERT INTO fiscal_outgoing_nfse_events(tenant_id,id,issuance_id,event_type,from_status,to_status,details,auth_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [context.tenantId, randomUUID(), id.data, `fiscal.outgoing_nfse.${normalized.status}`, prepared.row.status, normalized.status, { code: normalized.code ?? null, reason: normalized.reason }, context.authSubject])
      const snapshot: IssuanceSnapshot = { tenantId: context.tenantId, data: { id: id.data, externalId: prepared.row.external_id, status: normalized.status, revision: revision.toString(), ...(normalized.accessKey ? { accessKey: normalized.accessKey } : {}), reason: normalized.reason } }
      await context.client.query("UPDATE domain_commands SET result=$4 WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.authSubject, key, snapshot])
      await record(context, request.headers, "outgoing_nfse", id.data, `fiscal.outgoing_nfse.${normalized.status}`, { previousStatus: prepared.row.status, revision: revision.toString() })
      return snapshot
    })
    return reply.code(normalized.status === "uncertain" ? 202 : 200).send(body)
  })

  app.post("/api/v1/integrations/nfse/issuances/:id/cancel", async (request, reply) => {
    const fiscal = dependencies.outgoingNfse ?? unavailable()
    const id = idSchema.safeParse((request.params as { id?: string }).id)
    const input = cancelSchema.safeParse(request.body)
    if (!id.success || !input.success) throw new Problem(422, "invalid_input", "Cancelamento de NFS-e inválido")
    const key = commandKey(request.headers["idempotency-key"])
    const prepared = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.cancel")
      const prior = await replay(context, key, "fiscal.outgoing_nfse.cancel", { id: id.data, ...input.data }) as IssuanceSnapshot | undefined
      if (prior) return { replayed: prior }
      const row = (await context.client.query<{ external_id: string; status: string; access_key: string }>("SELECT external_id,status,access_key FROM fiscal_outgoing_nfse_issuances WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id.data])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Emissão de NFS-e não encontrada")
      if (row.status !== "authorized" || !row.access_key) throw new Problem(409, "domain_conflict", "Somente NFS-e autorizada pode ser cancelada")
      const material = await fiscal.certificateProvider(context)
      const processing: IssuanceSnapshot = { tenantId: context.tenantId, data: { id: id.data, externalId: row.external_id, status: "authorized", revision: 1, accessKey: row.access_key, reason: "Cancelamento em processamento" } }
      await remember(context, key, "fiscal.outgoing_nfse.cancel", { id: id.data, ...input.data }, processing)
      return { row, material }
    })
    if ("replayed" in prepared) return reply.header("idempotency-replayed", "true").send(prepared.replayed)
    let result: FiscalEngineResult
    try {
      result = await fiscal.engine.cancel({ accessKey: prepared.row.access_key, issuerTaxId: prepared.material.issuerTaxId, certificate: prepared.material.certificate, occurredAt: fiscalTimestamp(), applicationVersion: "erp-ts-0.1", ...input.data })
    } catch {
      result = { status: "uncertain", accessKey: prepared.row.access_key, code: "fiscal_operation_uncertain", reason: "Cancelamento não confirmado; consulte a situação antes de repetir" }
    }
    const body = await authorize(request, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.cancel")
      if (result.status === "cancelled") {
        await context.client.query("UPDATE fiscal_outgoing_nfse_issuances SET status='cancelled',error_code=NULL,error_message=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND status='authorized'", [context.tenantId, id.data, result.reason])
        await context.client.query("INSERT INTO fiscal_outgoing_nfse_events(tenant_id,id,issuance_id,event_type,from_status,to_status,details,auth_subject) VALUES($1,$2,$3,'fiscal.outgoing_nfse.cancelled','authorized','cancelled',$4,$5)", [context.tenantId, randomUUID(), id.data, { reason: result.reason }, context.authSubject])
      }
      const snapshot: IssuanceSnapshot = { tenantId: context.tenantId, data: { id: id.data, externalId: prepared.row.external_id, status: result.status, revision: 2, accessKey: prepared.row.access_key, reason: result.reason } }
      await context.client.query("UPDATE domain_commands SET result=$4 WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.authSubject, key, snapshot])
      await record(context, request.headers, "outgoing_nfse", id.data, `fiscal.outgoing_nfse.${result.status}`, { reason: result.reason })
      return snapshot
    })
    return reply.code(result.status === "uncertain" ? 202 : 200).send(body)
  })
}
