import type { FastifyInstance } from "fastify"
import { z } from "zod"
import endpoints from "../document-endpoints.json" with { type: "json" }
import { authorizeRequest, requirePermission, type AccessDependencies } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { openParticipantSession, participantOperation } from "./participant-session.js"
import { preparePersonalSignatures, readSigningDocument, uploadSigningDocument, type WorkflowTransaction } from "./workflow.js"

const ids = z.object({ tenant: z.guid(), id: z.guid(), documentId: z.guid().optional() })
type Params = { id:string; tenant:string; documentId?:string }
function boundary(params: Params) {
  if (!ids.safeParse(params).success) throw new Problem(404,"not_found","Contrato não encontrado")
  return { tenantId: params.tenant.toLowerCase(),contractId: params.id.toLowerCase() }
}

export function registerParticipantRoutes(app: FastifyInstance, deps: AccessDependencies) {
  app.post<{Params:{id:string}}>(endpoints["prepare-signatures"].POST, async (request, reply) => {
    const id = request.params.id.toLowerCase()
    if (!z.guid().safeParse(id).success) throw new Problem(404,"not_found","Contrato não encontrado")
    const tx: WorkflowTransaction = (action, write = true) => authorizeRequest(request,deps,context => {
      for (const permission of ["sales.orders.read","sales.orders.manage","sales.contracts.send"]) requirePermission(context,permission)
      return action(context)
    },write)
    const state = await preparePersonalSignatures(tx,id)
    return reply.header("cache-control","no-store").header("etag",`"${state.revision}"`).send(state)
  })

  app.post<{Params:Params}>(endpoints["signer-session"].POST, { bodyLimit:8192 }, async (request,reply) => {
    const cookie = request.headers["x-contract-portal-verification"]
    const token = await openParticipantSession(deps.pool,boundary(request.params),typeof cookie === "string" ? cookie : undefined)
    return reply.header("cache-control","no-store").send({token})
  })
  app.get<{Params:Params}>(endpoints["signer-session"].GET, async (request,reply) => {
    const run = participantOperation(deps.pool,boundary(request.params),request.headers.authorization)
    const docs = await run(async ({client,tenantId}, {envelopeId,participantId}) => {
      const { rows } = await client.query(`SELECT d.id,d.filename,d.position,h.sequence>=p.position AS done,
        s.revision::text AS "stageRevision",h.revision::text AS "headRevision",h.sha256 AS "parentSha256"
        FROM contract_signature_documents d JOIN contract_signature_heads h ON (h.tenant_id,h.envelope_id,h.document_id)=(d.tenant_id,d.envelope_id,d.id)
        JOIN contract_signature_states s ON s.tenant_id=d.tenant_id AND s.envelope_id=d.envelope_id
        JOIN contract_signature_participants p ON p.tenant_id=d.tenant_id AND p.envelope_id=d.envelope_id AND p.id=$3
        WHERE d.tenant_id=$1 AND d.envelope_id=$2 ORDER BY d.position`,[tenantId,envelopeId,participantId])
      return rows
    })
    return reply.header("cache-control","no-store").send({documents:docs})
  })
  app.get<{Params:Params}>(endpoints["signer-document"].GET, async (request,reply) => {
    const run = participantOperation(deps.pool,boundary(request.params),request.headers.authorization)
    const file = await run((ctx,identity) => readSigningDocument(ctx,{...identity,documentId:request.params.documentId!}))
    return reply.type("application/pdf").header("cache-control","no-store").header("content-disposition","attachment; filename=contrato-para-assinar.pdf")
      .header("etag",`"${file.stageRevision}:${file.headRevision}:${file.sha256}"`).send(file.content)
  })
  app.register(async pdf => {
    pdf.addContentTypeParser("application/pdf",{parseAs:"buffer"},(_req,buffer,done) => done(null,buffer))
    pdf.post<{Params:Params;Body:Buffer}>(endpoints["signer-document"].POST, { bodyLimit:32*1024*1024 }, async (request,reply) => {
      const run = participantOperation(deps.pool,boundary(request.params),request.headers.authorization)
      if (!Buffer.isBuffer(request.body) || request.body.subarray(0,5).toString() !== "%PDF-") throw new Problem(422,"invalid_pdf","Escolha o PDF assinado")
      if (!request.headers["if-match"]) throw new Problem(428,"missing_revision","Reabra os documentos para conferir a revisão")
      const match = /^"([1-9]\d{0,18}):([1-9]\d{0,18}):([a-f0-9]{64})"$/.exec(String(request.headers["if-match"]))
      if (!match) throw new Problem(400,"invalid_revision","Revisão do documento inválida")
      const identity = await run(async (_ctx,who) => who)
      const tx: WorkflowTransaction = (action,write=true) => run((ctx,who) => {
        if (who.envelopeId !== identity.envelopeId || who.participantId !== identity.participantId) throw new Problem(403,"participant_changed","Reabra o convite")
        return action(ctx)
      },write)
      const state = await uploadSigningDocument(tx,{...identity,documentId:request.params.documentId!,content:request.body,
        stageRevision:match[1]!,headRevision:match[2]!,parentSha256:match[3]!}).catch(error => {
        if (error instanceof Problem && error.code === "signature_stage_changed") throw new Problem(412,"stale_revision","O documento mudou. Abra a versão atual para assinar")
        throw error
      })
      return reply.header("cache-control","no-store").send({phase:state.phase,revision:state.revision})
    })
  })
}
