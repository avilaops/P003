import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import endpoints from "../document-endpoints.json" with { type: "json" }
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision } from "../../platform/revision.js"
import { validDocument } from "../parties/schema.js"
import { identityKeyring, normalizeCpf, openCpf, sealCpf, type FrozenIdentity, type IdentityKeyring } from "./identities.js"
import { reissuePortal, type FrozenTemplate, type PortalRecipient, type PublishedVersion } from "./reissue-portal.js"
import { validatorConfiguration } from "./validator-config.js"
import { POLICY_SHA256 } from "./validator-wire.js"

const bodySchema = z.strictObject({ participants: z.array(z.strictObject({
  role: z.string().min(1).max(100), cpf: z.string().max(14).transform(normalizeCpf).pipe(z.string()),
  representedCnpj: z.string().refine(value => validDocument(value, "juridica")).optional(),
  representationReference: z.string().trim().min(1).max(2000).refine(value => !/\p{Cc}/u.test(value)).optional()
}).refine(value => !!value.representedCnpj === !!value.representationReference)).min(1).max(10) })
type Participants = z.infer<typeof bodySchema>["participants"]

type Source = {
  tenantId: string; id: string; revision: string; policy: string; orderStatus: string; derivedId: string | null;
  versionId: string | null; requestHash: string | null; templateId: string;
  recipients: PortalRecipient[]; template: FrozenTemplate; fields: Record<string, string>
}
const qualifiedFingerprint = (tenant: string, id: string) =>
  createHash("sha256").update(`AVILA-QUALIFIED-REISSUE/1\n${tenant}\n${id}\n`).digest("hex")

async function source(context: AuthorizedContext, id: string, lock = false) {
  for (const p of ["sales.orders.read", "sales.orders.manage", "sales.contracts.send"]) requirePermission(context, p)
  const row = (await context.client.query<Source>(`
    SELECT c.tenant_id AS "tenantId",c.id,c.revision::text,c.signature_policy AS policy,o.status AS "orderStatus",
      c.template_id::text AS "templateId",c.recipients,c.template_snapshot AS template,c.fields,
      v.id AS "versionId",v.request_hash AS "requestHash",q.id AS "derivedId"
    FROM commercial_contracts c JOIN sales_orders o ON (o.tenant_id,o.id)=(c.tenant_id,c.order_id)
    LEFT JOIN commercial_template_versions v ON v.tenant_id=c.tenant_id AND v.external_id=c.template_id
      AND c.template_snapshot->>'external_id'=concat('avila:',v.id,':',v.request_hash) AND v.published_at IS NOT NULL
    LEFT JOIN commercial_contracts q ON q.tenant_id=c.tenant_id AND q.fingerprint=$3 AND q.signature_policy='icp_each_participant'
    WHERE c.tenant_id=$1 AND c.id=$2 ${lock ? "FOR SHARE OF c,o" : ""}`, [context.tenantId, id, qualifiedFingerprint(context.tenantId, id)])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Contrato não encontrado")
  return row
}
function eligible(s: Source) {
  if (s.policy !== "legacy_docuseal") return "Este contrato já exige o e-CPF dos participantes."
  if (s.orderStatus === "cancelled") return "O pedido está cancelado."
  if (!s.versionId || !s.requestHash) return "Para gerar a via com e-CPF, crie uma prévia a partir de uma versão publicada do modelo pelo ERP."
  const roles = s.template.submitters
  if (!Array.isArray(roles) || !Array.isArray(s.template.fields) || !Array.isArray(s.recipients) || !s.recipients.length ||
    s.recipients.length > 10 || roles.length !== s.recipients.length || new Set(s.recipients.map(r => r.role)).size !== roles.length ||
    !s.recipients.every(r => roles.some(t => t.name === r.role && t.uuid)))
    return "Os participantes preservados divergem dos papéis da versão publicada."
  return null
}
function configuration() {
  const ring = identityKeyring()
  try {
    const { trust, key } = validatorConfiguration(process.env)
    key.secret.fill(0)
    return { ring, trustSha256: trust.sha256, portal: reissuePortal() }
  } catch (error) {
    if (error instanceof Problem) throw error
    throw new Problem(503, "contract_validator_unavailable", "O validador de assinaturas ICP-Brasil está indisponível")
  }
}
type Config = ReturnType<typeof configuration>
const version = (s: Source): PublishedVersion => ({ versionId: s.versionId!, requestHash: s.requestHash!, templateId: s.templateId })

function roster(s: Source, participants: Participants) {
  if (participants.length !== s.recipients.length || !s.recipients.every((value, index) => value.role === participants[index]?.role))
    throw new Problem(422, "invalid_signers", "Informe o CPF de cada participante na ordem apresentada")
}
async function confirmExisting(context: AuthorizedContext, id: string, ring: IdentityKeyring, participants: Participants) {
  const frozen = (await context.client.query<FrozenIdentity & { id: string; envelope_id: string; role: string;
    represented_cnpj: string | null; representation_reference: string | null }>(`
    SELECT p.* FROM contract_signature_participants p JOIN contract_signature_envelopes e
      ON (e.tenant_id,e.id)=(p.tenant_id,p.envelope_id)
    WHERE e.tenant_id=$1 AND e.contract_id=$2 ORDER BY p.position`, [context.tenantId, id])).rows
  if (frozen.length !== participants.length || !frozen.every((p, index) => {
    const value = participants[index]!
    return p.role === value.role && p.represented_cnpj === (value.representedCnpj ?? null) &&
      p.representation_reference === (value.representationReference ?? null) &&
      openCpf(ring, context.tenantId, p.envelope_id, p.id, p) === value.cpf
  })) throw new Problem(409, "frozen_signers_changed", "Os participantes desta via já foram fixados com outros dados")
}
async function freeze(context: AuthorizedContext, s: Source, participants: Participants, config: Config) {
  const tenant = context.tenantId, id = randomUUID(), envelope = randomUUID()
  await context.client.query(`INSERT INTO commercial_contracts
    (id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status,signature_policy)
    SELECT $3,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,$4,'creation_requested','icp_each_participant'
    FROM commercial_contracts WHERE tenant_id=$1 AND id=$2`, [tenant, s.id, id, qualifiedFingerprint(tenant, s.id)])
  await context.client.query(`INSERT INTO contract_signature_envelopes(tenant_id,id,contract_id,policy,policy_sha256,trust_bundle_sha256,participant_count)
    VALUES($1,$2,$3,'icp_each_participant',$4,$5,$6)`, [tenant, envelope, id, POLICY_SHA256, config.trustSha256, participants.length])
  for (const [i, person] of participants.entries()) {
    const recipient = s.recipients[i]!, participant = randomUUID()
    const encrypted = sealCpf(config.ring, tenant, envelope, participant, person.cpf)
    await context.client.query(`INSERT INTO contract_signature_participants
      (tenant_id,envelope_id,id,position,role,name,email,cpf_masked,identity_key_id,identity_nonce,identity_ciphertext,represented_cnpj,representation_reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [tenant, envelope, participant, i + 1, recipient.role, recipient.name, recipient.email,
      "***.***.***-" + person.cpf.slice(-2), encrypted.identity_key_id, encrypted.identity_nonce, encrypted.identity_ciphertext,
      person.representedCnpj ?? null, person.representationReference ?? null])
  }
  await context.client.query("INSERT INTO contract_signature_states(tenant_id,envelope_id,phase) VALUES($1,$2,'portal_pending')", [tenant, envelope])
  return id
}

export function registerQualifiedReissue(app: FastifyInstance, deps: AccessDependencies, configure: () => Config = configuration) {
  const parseId = (id: string) => {
    if (!z.guid().safeParse(id).success) throw new Problem(404, "not_found", "Contrato não encontrado")
    return id.toLowerCase()
  }
  app.get<{ Params: { id: string } }>(endpoints["qualified-reissue"].GET, async (request, reply) => {
    const s = await authorizeRequest(request, deps, context => source(context, parseId(request.params.id)), false)
    let reason = eligible(s)
    if (!reason && !s.derivedId) {
      try { configure() } catch (error) { reason = error instanceof Problem ? error.message : "A integração de assinatura está indisponível." }
    }
    return reply.header("etag", `"${s.revision}"`).header("cache-control", "no-store")
      .send({ tenantId: s.tenantId, sourceId: s.id, revision: s.revision, eligible: !reason, reason, qualifiedId: s.derivedId, policy: s.policy })
  })
  app.post<{ Params: { id: string } }>(endpoints["qualified-reissue"].POST, async (request, reply) => {
    const id = parseId(request.params.id), key = commandKey(request.headers["idempotency-key"]), revision = String(parseRevision(request.headers["if-match"]))
    const parsed = bodySchema.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_signers", "Confira o CPF e a identificação de cada participante")
    const participants = parsed.data.participants
    const previous = await authorizeRequest(request, deps, context => source(context, id), false)
    const reason = eligible(previous)
    if (reason && !previous.derivedId) throw new Problem(409, "qualified_reissue_unavailable", reason)
    roster(previous, participants)
    const config = configure()
    if (!previous.derivedId) {
      if (previous.revision !== revision) throw new Problem(412, "stale_revision", "Atualize a revisão do contrato")
      await config.portal.verify(version(previous))
    }
    const result = await authorizeRequest(request, deps, async context => {
      const s = await source(context, id, true), scope = "contract.qualified_reissue", command = { source: id, revision }
      const prior = await replay(context, key, scope, command)
      if (s.derivedId) {
        await confirmExisting(context, s.derivedId, config.ring, participants)
        if (!prior) {
          if (revision !== s.revision) throw new Problem(412, "stale_revision", "Atualize a revisão do contrato")
          await remember(context, key, scope, command, { id: s.derivedId })
        }
        return { id: s.derivedId, dispatch: false }
      }
      if (prior) throw new Problem(409, "reissue_unconfirmed", "A referência da via qualificada não pôde ser conferida")
      const blocked = eligible(s)
      if (blocked) throw new Problem(409, "qualified_reissue_unavailable", blocked)
      if (s.revision !== revision) throw new Problem(412, "stale_revision", "Atualize a revisão do contrato")
      const qualifiedId = await freeze(context, s, participants, config)
      await remember(context, key, scope, command, { id: qualifiedId })
      await record(context, request.headers, "commercial_contract", qualifiedId, "contract.qualified_reissue", { sourceContractId: id, participants: participants.length, versionId: s.versionId })
      return { id: qualifiedId, dispatch: true }
    })
    let portalConfirmed = false
    if (result.dispatch) {
      // The frozen envelope and dispatch claim are durable. Resubmits only reconcile the original creation.
      try {
        await config.portal.create(previous.tenantId, result.id, version(previous), previous.template, previous.recipients, previous.fields)
        portalConfirmed = true
      } catch { /* Existing sync reconciles the stable participant correlation without resending. */ }
    }
    return reply.header("etag", `"${revision}"`).header("cache-control", "no-store")
      .send({ tenantId: previous.tenantId, sourceId: id, qualifiedId: result.id, portalConfirmed })
  })
}
