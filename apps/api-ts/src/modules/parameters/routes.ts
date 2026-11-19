import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { authorizedDomain, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { parseRevision } from "../../platform/revision.js"
import { parseBody, reply } from "../system-config/http.js"
import { parameterSelect, presentParameter, validateParameterValue, type ParameterRow } from "./catalog.js"

const READ = "system.parameters.read", MANAGE = "system.parameters.manage"
const codePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const listQuery = z.strictObject({ q: z.string().trim().max(120).optional(), module: z.string().regex(/^[a-z_]{1,40}$/).optional() })
// `value: null` volta ao padrão do catálogo; qualquer outro valor é validado pela definição.
const updateSchema = z.strictObject({ value: z.union([z.boolean(), z.number(), z.string(), z.null()]) })

export function registerParameterRoutes(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/parameters", async (request, response) => {
    const query = listQuery.safeParse(request.query)
    if (!query.success) throw invalid("Filtro de parâmetros inválido")
    const body = await authorizedDomain(request, dependencies, READ, MANAGE, false, async (context, canEdit) => {
      const term = query.data.q ? `%${query.data.q.replace(/[\\%_]/g, m => "\\" + m)}%` : null
      const rows = await context.client.query<ParameterRow>(`${parameterSelect}
        WHERE ($2::text IS NULL OR d.code ILIKE $2 OR d.label ILIKE $2 OR d.description ILIKE $2)
          AND ($3::text IS NULL OR d.module=$3) ORDER BY d.module,d.label,d.code`, [context.tenantId, term, query.data.module ?? null])
      return { tenantId: context.tenantId, canEdit, data: rows.rows.map(presentParameter) }
    })
    return reply(response, 200, body)
  })

  app.get<{ Params: { code: string } }>("/api/v1/parameters/:code", async (request, response) => {
    const { body, revision } = await authorizedDomain(request, dependencies, READ, MANAGE, false, async (context, canEdit) => {
      const data = await load(context.client, context.tenantId, request.params.code)
      const history = await context.client.query(`SELECT a.details->'previous' AS previous,a.details->'value' AS value,
          coalesce(i.display_name,i.email) actor,to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "occurredAt"
        FROM audit_log a LEFT JOIN identities i ON i.id=a.identity_id
        WHERE a.tenant_id=$1 AND a.entity_type='parameter' AND a.entity_id=$2 ORDER BY a.occurred_at DESC,a.id DESC LIMIT 20`, [context.tenantId, data.code])
      return { body: { tenantId: context.tenantId, canEdit, data, history: history.rows }, revision: data.revision }
    })
    return reply(response, 200, body, revision)
  })

  app.put<{ Params: { code: string } }>("/api/v1/parameters/:code", async (request, response) => {
    const expected = parseRevision(request.headers["if-match"])
    const { body, revision } = await authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const input = parseBody(updateSchema, request.body, "Valor do parâmetro inválido ou contém campos desconhecidos")
      const { client, tenantId } = context
      const row = await loadRow(client, tenantId, request.params.code)
      const current = presentParameter(row)
      if (BigInt(current.revision) !== BigInt(expected)) throw staleRevision()
      const value = input.value === null ? null : validateParameterValue(row, input.value)
      const stored = value === null || value === row.default_value ? null : value
      await client.query(`INSERT INTO parameter_values(tenant_id,code,value,updated_by) VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT(tenant_id,code) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=clock_timestamp(),revision=parameter_values.revision+1`,
        [tenantId, row.code, stored === null ? null : JSON.stringify(stored), context.authSubject])
      const data = await load(client, tenantId, row.code)
      await record(context, request.headers, "parameter", row.code, "parameter.updated", { previous: current.value, value: data.value, customized: data.customized })
      return { body: { tenantId, data }, revision: data.revision }
    })
    return reply(response, 200, body, revision)
  })
}

async function loadRow(client: Parameters<typeof load>[0], tenantId: string, code: string) {
  if (!codePattern.test(code) || code.length > 120) throw notFound()
  const row = (await client.query<ParameterRow>(`${parameterSelect} WHERE d.code=$2`, [tenantId, code])).rows[0]
  if (!row) throw notFound()
  return row
}

async function load(client: import("../../platform/database.js").DatabaseClient, tenantId: string, code: string) {
  return presentParameter(await loadRow(client, tenantId, code))
}
