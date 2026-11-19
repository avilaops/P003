import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { stringifyJson } from "../../platform/json.js"
import { parseRevision } from "../../platform/revision.js"
import { createdAt, hasControl, parseBody, reply, validId, withRevision } from "./http.js"

const READ = "system.custom_fields.read", MANAGE = "system.custom_fields.manage"
const columns = `id,entity_type,code,label,value_type,required,choices,status,revision,${createdAt} created_at`
const inputSchema = z.strictObject({
  entityType: z.string(), code: z.string(), label: z.string(), valueType: z.string(),
  required: z.boolean().default(false), choices: z.array(z.string()).default([]), status: z.string().default("active"),
})
type Input = z.infer<typeof inputSchema>

function validate(raw: Input): Input {
  const input = { ...raw, label: raw.label.trim() }
  if (!["product", "party", "sales_order"].includes(input.entityType)) throw invalid("Entidade de campo customizado inválida")
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.code)) throw invalid("Código deve começar com letra minúscula e usar apenas letras, números ou sublinhado")
  if (!input.label || Buffer.byteLength(input.label) > 120 || hasControl(input.label)) throw invalid("Nome deve ter entre 1 e 120 caracteres")
  if (!["text", "number", "boolean", "date", "choice"].includes(input.valueType)) throw invalid("Tipo de valor inválido")
  if (!["active", "archived"].includes(input.status)) throw invalid("Situação inválida")
  if (input.valueType === "choice") {
    const choices = input.choices.map(value => value.trim()).filter(Boolean)
    if (!choices.length || choices.length > 100 || choices.some(value => Buffer.byteLength(value) > 120 || hasControl(value))) throw invalid("Informe de 1 a 100 opções válidas")
    input.choices = [...new Set(choices.sort())]
  } else if (input.choices.length) throw invalid("Opções são permitidas somente em campos de seleção")
  return input
}

export function registerCustomFields(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/system/custom-fields", async (request, response) => {
    const body = await authorizedDomain(request, dependencies, READ, MANAGE, false, async (context, canEdit) => {
      const rows = await context.client.query(`SELECT ${columns} FROM system_config.custom_fields WHERE tenant_id=$1 ORDER BY status,label,id`, [context.tenantId])
      return { tenantId: context.tenantId, data: rows.rows.map(withRevision), canEdit }
    })
    return reply(response, 200, body)
  })

  app.post("/api/v1/system/custom-fields", async (request, response) => {
    const { body, revision } = await authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const input = validate(parseBody(inputSchema, request.body, "Campo customizado inválido ou contém campos desconhecidos"))
      const id = randomUUID()
      const inserted = await context.client.query("INSERT INTO system_config.custom_fields(tenant_id,id,entity_type,code,label,value_type,required,choices,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT (tenant_id,entity_type,code) DO NOTHING RETURNING id",
        [context.tenantId, id, input.entityType, input.code, input.label, input.valueType, input.required, stringifyJson(input.choices), input.status])
      if (!inserted.rows.length) throw conflict("Já existe um campo com este código para a entidade")
      await record(context, request.headers, "custom_field", id, "custom_field.created", { entityType: input.entityType, code: input.code })
      const data = withRevision((await context.client.query(`SELECT ${columns} FROM system_config.custom_fields WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]!)
      return { body: { tenantId: context.tenantId, data }, revision: data.revision }
    })
    return reply(response, 201, body, revision)
  })

  app.put<{ Params: { id: string } }>("/api/v1/system/custom-fields/:id", async (request, response) => {
    const expected = parseRevision(request.headers["if-match"])
    const { body, revision } = await authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const input = validate(parseBody(inputSchema, request.body, "Campo customizado inválido ou contém campos desconhecidos"))
      const id = request.params.id
      if (!validId(id)) throw notFound()
      const changed = await context.client.query("UPDATE system_config.custom_fields SET label=$3,required=$4,status=$5,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND revision=$6 AND entity_type=$7 AND code=$8 AND value_type=$9 AND choices=$10::jsonb RETURNING id",
        [context.tenantId, id, input.label, input.required, input.status, expected, input.entityType, input.code, input.valueType, stringifyJson(input.choices)])
      if (!changed.rows.length) {
        const exists = await context.client.query("SELECT 1 FROM system_config.custom_fields WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])
        throw exists.rows.length ? staleRevision() : notFound()
      }
      const data = withRevision((await context.client.query(`SELECT ${columns} FROM system_config.custom_fields WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]!)
      await record(context, request.headers, "custom_field", id, input.status === "archived" ? "custom_field.archived" : "custom_field.updated", { revision: data.revision })
      return { body: { tenantId: context.tenantId, data }, revision: data.revision }
    })
    return reply(response, 200, body, revision)
  })
}
