import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { authorizedDomain, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { stringifyJson } from "../../platform/json.js"
import { parseRevision } from "../../platform/revision.js"
import { createdAt, hasControl, parseBody, reply, validId, withRevision } from "./http.js"

const PERMISSION = "system.labels.manage"
const columns = `id,name,width_mm::float8 width_mm,height_mm::float8 height_mm,layout,revision,${createdAt} created_at`
const sources: Record<string, string[]> = {
  product: ["code", "name", "unit", "price"], party: ["name", "document", "kind"], sales_order: ["number", "customer", "issued_at", "total"],
}
const element = z.strictObject({
  kind: z.string(), field: z.string(), label: z.string().default(""),
  xMm: z.number(), yMm: z.number(), widthMm: z.number(), heightMm: z.number(), fontSizePt: z.number().default(10),
})
const inputSchema = z.strictObject({ name: z.string(), widthMm: z.number(), heightMm: z.number(), source: z.string(), elements: z.array(element) })
type Input = z.infer<typeof inputSchema>

function validate(raw: Input): Input {
  const input = { ...raw, name: raw.name.trim() }
  if (!input.name || Buffer.byteLength(input.name) > 120 || hasControl(input.name)) throw invalid("Nome deve ter entre 1 e 120 caracteres")
  if (!(input.widthMm >= 10 && input.widthMm <= 300 && input.heightMm >= 10 && input.heightMm <= 300)) throw invalid("Largura e altura devem estar entre 10 e 300 mm")
  const fields = sources[input.source]
  if (!fields) throw invalid("Fonte de dados da etiqueta inválida")
  if (!input.elements.length || input.elements.length > 32) throw invalid("A etiqueta deve conter entre 1 e 32 elementos")
  input.elements = input.elements.map(item => {
    const label = item.label.trim()
    if (!["text", "barcode"].includes(item.kind)) throw invalid("Tipo de elemento inválido")
    if (!fields.includes(item.field)) throw invalid("Campo não autorizado para a fonte selecionada")
    if (Buffer.byteLength(label) > 80 || hasControl(label)) throw invalid("Rótulo do elemento deve ter até 80 caracteres")
    if (item.xMm < 0 || item.yMm < 0 || item.widthMm <= 0 || item.heightMm <= 0 || item.xMm + item.widthMm > input.widthMm || item.yMm + item.heightMm > input.heightMm || !(item.fontSizePt >= 4 && item.fontSizePt <= 72)) throw invalid("Elemento fora dos limites da etiqueta")
    return { ...item, label }
  })
  return input
}
const layout = (input: Input) => stringifyJson({ source: input.source, elements: input.elements })

export function registerLabelTemplates(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/system/label-templates", async (request, response) => {
    const body = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, false, async (context, canEdit) => {
      const rows = await context.client.query(`SELECT ${columns} FROM system_config.label_templates WHERE tenant_id=$1 ORDER BY name,id`, [context.tenantId])
      return { tenantId: context.tenantId, data: rows.rows.map(withRevision), canEdit }
    })
    return reply(response, 200, body)
  })

  app.post("/api/v1/system/label-templates", async (request, response) => {
    const { body, revision } = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
      const input = validate(parseBody(inputSchema, request.body, "Modelo de etiqueta inválido ou contém campos desconhecidos"))
      const id = randomUUID()
      await context.client.query("INSERT INTO system_config.label_templates(tenant_id,id,name,width_mm,height_mm,layout) VALUES($1,$2,$3,$4,$5,$6::jsonb)", [context.tenantId, id, input.name, input.widthMm, input.heightMm, layout(input)])
      await record(context, request.headers, "label_template", id, "label_template.created", { name: input.name })
      const data = withRevision((await context.client.query(`SELECT ${columns} FROM system_config.label_templates WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]!)
      return { body: { tenantId: context.tenantId, data }, revision: data.revision }
    })
    return reply(response, 201, body, revision)
  })

  app.put<{ Params: { id: string } }>("/api/v1/system/label-templates/:id", async (request, response) => {
    const expected = parseRevision(request.headers["if-match"])
    const { body, revision } = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
      const input = validate(parseBody(inputSchema, request.body, "Modelo de etiqueta inválido ou contém campos desconhecidos"))
      const id = request.params.id
      if (!validId(id)) throw notFound()
      const changed = await context.client.query("UPDATE system_config.label_templates SET name=$3,width_mm=$4,height_mm=$5,layout=$6::jsonb,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND revision=$7 RETURNING id", [context.tenantId, id, input.name, input.widthMm, input.heightMm, layout(input), expected])
      if (!changed.rows.length) {
        const exists = await context.client.query("SELECT 1 FROM system_config.label_templates WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])
        throw exists.rows.length ? staleRevision() : notFound()
      }
      const data = withRevision((await context.client.query(`SELECT ${columns} FROM system_config.label_templates WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]!)
      await record(context, request.headers, "label_template", id, "label_template.updated", { revision: data.revision })
      return { body: { tenantId: context.tenantId, data }, revision: data.revision }
    })
    return reply(response, 200, body, revision)
  })
}
