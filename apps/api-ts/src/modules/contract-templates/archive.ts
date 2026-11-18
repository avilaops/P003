import type { FastifyInstance } from "fastify"
import endpoints from "../document-endpoints.json" with { type: "json" }
import { z } from "zod"

import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue, type Revision } from "../../platform/revision.js"

const MANAGE = "platform.integrations.manage"
const SCOPE = "contract_template_draft.archive"
const draftId = z.guid()
const archivedTemplate = z.object({ id: z.number().int().positive(), archived_at: z.string().min(1) })

/** Archives a published model in the signature portal, so it stops being offered to new orders. */
export type TemplatePortal = { archiveTemplate(templateId: number): Promise<void> }

export function templatePortal(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): TemplatePortal {
  const origin = env.DOCUSEAL_URL || "https://contrato.avilaops.com"
  const token = env.DOCUSEAL_API_TOKEN
  return {
    async archiveTemplate(templateId) {
      if (!token || token.length < 16 || !/^https:\/\/contrato\.avilaops\.com\/?$/.test(origin))
        throw new Problem(503, "contract_portal_unavailable", "A integração com o portal de contratos está indisponível")
      let body: unknown
      try {
        const response = await http(new URL(`/api/templates/${templateId}`, origin), {
          method: "DELETE", headers: { "X-Auth-Token": token }, redirect: "error", signal: AbortSignal.timeout(12_000),
        })
        const text = await response.text()
        if (!response.ok || text.length > 64 * 1024) throw new Error()
        body = JSON.parse(text)
      } catch {
        throw new Problem(503, "contract_portal_unavailable", "O portal ainda não confirmou o arquivamento. Nada foi alterado no ERP; tente novamente")
      }
      const parsed = archivedTemplate.safeParse(body)
      if (!parsed.success || parsed.data.id !== templateId)
        throw new Problem(503, "contract_portal_unavailable", "O portal respondeu sem confirmar o arquivamento. Nada foi alterado no ERP; tente novamente")
    },
  }
}

export type ArchiveResult = { tenantId: string; id: string; archived: true; revision: string; archivedTemplates: number[] }

export async function archiveTemplateDraft(
  context: AuthorizedContext, id: string, expected: Revision, key: string,
  headers: Record<string, string | string[] | undefined>, portal: TemplatePortal,
): Promise<ArchiveResult> {
  requirePermission(context, MANAGE)
  const request = { id, revision: String(expected) }
  const previous = await replay(context, key, SCOPE, request)
  if (previous) return previous as ArchiveResult

  // Archived drafts are hidden by the read policy, so an archived or foreign id is simply not found.
  const draft = (await context.client.query<{ revision: string; name: string | null }>(
    "SELECT revision::text,definition->>'name' AS name FROM commercial_template_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [context.tenantId, id])).rows[0]
  if (!draft) throw new Problem(404, "not_found", "Modelo não encontrado")
  if (revisionValue(draft.revision) !== expected)
    throw new Problem(412, "revision_conflict", "O modelo foi alterado por outra pessoa. Recarregue antes de excluir")

  const versions = (await context.client.query<{ external_id: string | null }>(
    "SELECT external_id::text FROM commercial_template_versions WHERE tenant_id=$1 AND draft_id=$2 ORDER BY draft_revision",
    [context.tenantId, id])).rows
  if (versions.some(version => version.external_id === null))
    throw new Problem(409, "publication_pending", "Há uma publicação deste modelo ainda sem confirmação. Conclua a publicação antes de excluir")
  const templates = versions.map(version => Number(version.external_id))

  // The portal is archived first: if it fails, the transaction rolls back and the model stays available.
  for (const template of templates) await portal.archiveTemplate(template)

  await context.client.query("SELECT set_config('app.include_archived','on',true)")
  const updated = (await context.client.query<{ revision: string }>(
    "UPDATE commercial_template_drafts SET archived_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL RETURNING revision::text",
    [context.tenantId, id])).rows[0]
  await context.client.query("SELECT set_config('app.include_archived','',true)")
  if (!updated) throw new Problem(409, "domain_conflict", "O modelo mudou durante o arquivamento. Recarregue a lista")

  const result: ArchiveResult = { tenantId: context.tenantId, id, archived: true, revision: updated.revision, archivedTemplates: templates }
  await record(context, headers, "contract_template_draft", id, "contract_template_draft.archived",
    { name: draft.name, revision: String(expected), archivedTemplates: templates })
  await remember(context, key, SCOPE, request, result)
  return result
}

export function registerContractTemplateArchive(app: FastifyInstance, dependencies: AccessDependencies, portal: TemplatePortal = templatePortal()) {
  app.post<{ Params: { id: string } }>(endpoints["contract-template-archive"].POST, async (request, reply) => {
    const id = draftId.safeParse(request.params.id)
    if (!id.success) throw new Problem(404, "not_found", "Modelo não encontrado")
    const expected = parseRevision(request.headers["if-match"])
    const key = commandKey(request.headers["idempotency-key"])
    const result = await authorizeRequest(request, dependencies,
      context => archiveTemplateDraft(context, id.data.toLowerCase(), expected, key, request.headers, portal))
    return reply.header("cache-control", "no-store").header("etag", `"${result.revision}"`).send(result)
  })
}
