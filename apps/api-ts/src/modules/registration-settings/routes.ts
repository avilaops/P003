import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer } from "../registrations/query.js"
import { defaultsBySection, schemas, type Section } from "./schema.js"

function sectionName(raw: string): Section {
  if (!Object.hasOwn(schemas, raw)) throw new Problem(404, "not_found", "Seção desconhecida")
  return raw as Section
}

function expectedRevision(value: string | string[] | undefined) {
  if (value === undefined) throw new Problem(428, "revision_required", "Recarregue o cadastro antes de salvar")
  const match = typeof value === "string" ? /^"(\d+)"$/.exec(value) : null
  const number = match ? Number(match[1]) : NaN
  if (!Number.isSafeInteger(number) || number <= 0) throw new Problem(400, "invalid_revision", "Revisão inválida")
  return number
}

async function load(context: AuthorizedContext, section: Section) {
  const rows = await context.client.query<{ revision: string | number; data: unknown }>("SELECT revision,data FROM registration_settings WHERE tenant_id=$1 AND section=$2", [context.tenantId, section])
  return { revision: integer(rows.rows[0]?.revision ?? 1), data: rows.rows[0]?.data ?? defaultsBySection[section] }
}

export function registerRegistrationSettingsRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { section: string } }>("/api/v1/registration-settings/:section", async (request, reply) => {
    const section = sectionName(request.params.section)
    const body = await authorizeRequest(request, dependencies, async context => {
      const canEdit = context.permissions.includes("platform.company.manage")
      const domainRead = section === "products" ? "catalog.products.read" : section === "tax-profiles" ? "fiscal.nfe.read" : "catalog.parties.read"
      if (!canEdit && !context.permissions.some(permission => ["platform.company.read", domainRead].includes(permission))) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
      return { tenantId: context.tenantId, canEdit, ...await load(context, section) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
  app.put<{ Params: { section: string } }>("/api/v1/registration-settings/:section", async (request, reply) => {
    const expected = expectedRevision(request.headers["if-match"])
    const section = sectionName(request.params.section)
    const parsed = schemas[section].safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Configuração inválida ou campos desconhecidos")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "platform.company.manage")
      const current = await load(context, section)
      if (current.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      const revision = current.revision + 1
      await context.client.query("INSERT INTO registration_settings(tenant_id,section,data,revision) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,section) DO UPDATE SET data=$3,revision=$4,updated_at=now()", [context.tenantId, section, parsed.data, revision])
      await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,details) SELECT $1,id,'registration_settings.updated','registration_settings',$3 FROM identities WHERE auth_subject=$2", [context.tenantId, context.authSubject, { section, previousRevision: current.revision, revision }])
      return { tenantId: context.tenantId, revision, canEdit: true, data: parsed.data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
}
