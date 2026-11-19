import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { AccessDependencies, AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { createdAt, hasControl, parseBody, reply, validId } from "./http.js"

const PERMISSION = "system.workflows.manage"
const stateInput = z.strictObject({ code: z.string(), label: z.string(), isInitial: z.boolean().default(false), isTerminal: z.boolean().default(false) })
const transitionInput = z.strictObject({ fromState: z.string(), toState: z.string(), permissionCode: z.string(), requiresReason: z.boolean().default(true) })
const inputSchema = z.strictObject({ code: z.string(), version: z.number().int(), name: z.string(), states: z.array(stateInput), transitions: z.array(transitionInput) })
type Input = z.infer<typeof inputSchema>
const title = "Fluxo inválido ou contém campos desconhecidos"
const validCode = (value: string) => /^[a-z][a-z0-9_]{0,62}$/.test(value)

function validate(raw: Input): Input {
  const input: Input = { ...raw, code: raw.code.trim(), name: raw.name.trim() }
  if (!validCode(input.code)) throw invalid("Código do fluxo inválido")
  if (input.version < 1 || input.version > 9999) throw invalid("Versão deve estar entre 1 e 9999")
  if (!input.name || Buffer.byteLength(input.name) > 120 || hasControl(input.name)) throw invalid("Nome deve ter entre 1 e 120 caracteres")
  if (input.states.length < 2 || input.states.length > 32) throw invalid("Informe entre 2 e 32 estados")
  if (input.transitions.length < 1 || input.transitions.length > 128) throw invalid("Informe entre 1 e 128 transições")
  const codes = new Set<string>()
  input.states = input.states.map(state => {
    const next = { ...state, code: state.code.trim(), label: state.label.trim() }
    if (!validCode(next.code) || codes.has(next.code)) throw invalid("Estados devem ter códigos válidos e únicos")
    codes.add(next.code)
    if (!next.label || Buffer.byteLength(next.label) > 120 || hasControl(next.label)) throw invalid("Rótulo de estado inválido")
    return next
  })
  if (input.states.filter(s => s.isInitial).length !== 1 || !input.states.some(s => s.isTerminal)) throw invalid("Defina um estado inicial e ao menos um estado final")
  const terminals = new Set(input.states.filter(s => s.isTerminal).map(s => s.code))
  const pairs = new Set<string>()
  input.transitions = input.transitions.map(item => {
    const next = { ...item, fromState: item.fromState.trim(), toState: item.toState.trim(), permissionCode: item.permissionCode.trim() }
    const pair = `${next.fromState}\0${next.toState}`
    if (next.fromState === next.toState || !codes.has(next.fromState) || !codes.has(next.toState) || pairs.has(pair)) throw invalid("Transições devem ligar estados distintos e não podem se repetir")
    pairs.add(pair)
    if (terminals.has(next.fromState)) throw invalid("Estados finais não podem ter transições de saída")
    if (!next.permissionCode || Buffer.byteLength(next.permissionCode) > 120) throw invalid("Permissão da transição inválida")
    return next
  })
  return input
}

type Row = { id: string; code: string; version: number; name: string; status: string; revision: number | string | bigint; created_at: string }
async function load(context: AuthorizedContext, only?: string) {
  const rows = (await context.client.query<Row>(`SELECT id,code,version,name,status,revision,${createdAt} created_at FROM system_config.workflow_definitions WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY code,version DESC,id`, [context.tenantId, only ?? null])).rows
  const result = []
  for (const row of rows) {
    const states = (await context.client.query<{ code: string; label: string; is_initial: boolean; is_terminal: boolean }>("SELECT code,label,is_initial,is_terminal FROM system_config.workflow_states WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY is_initial DESC,code", [context.tenantId, row.id])).rows
    const transitions = (await context.client.query<{ from_state: string; to_state: string; permission_code: string; requires_reason: boolean }>("SELECT from_state,to_state,permission_code,requires_reason FROM system_config.workflow_transitions WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY from_state,to_state", [context.tenantId, row.id])).rows
    result.push({
      id: row.id, code: row.code, version: row.version, name: row.name, status: row.status, revision: revisionValue(row.revision), createdAt: row.created_at,
      states: states.map(s => ({ code: s.code, label: s.label, isInitial: s.is_initial, isTerminal: s.is_terminal })),
      transitions: transitions.map(t => ({ fromState: t.from_state, toState: t.to_state, permissionCode: t.permission_code, requiresReason: t.requires_reason })),
    })
  }
  return result
}

async function replaceChildren(context: AuthorizedContext, id: string, input: Input) {
  const wanted = [...new Set(input.transitions.map(t => t.permissionCode))]
  const found = await context.client.query("SELECT code FROM permissions WHERE code = ANY($1::text[])", [wanted])
  if (found.rows.length !== wanted.length) throw invalid("Uma ou mais permissões não existem")
  await context.client.query("DELETE FROM system_config.workflow_transitions WHERE tenant_id=$1 AND workflow_id=$2", [context.tenantId, id])
  await context.client.query("DELETE FROM system_config.workflow_states WHERE tenant_id=$1 AND workflow_id=$2", [context.tenantId, id])
  for (const s of input.states) await context.client.query("INSERT INTO system_config.workflow_states(tenant_id,workflow_id,code,label,is_initial,is_terminal) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, id, s.code, s.label, s.isInitial, s.isTerminal])
  for (const t of input.transitions) await context.client.query("INSERT INTO system_config.workflow_transitions(tenant_id,workflow_id,from_state,to_state,permission_code,requires_reason) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, id, t.fromState, t.toState, t.permissionCode, t.requiresReason])
}

export function registerWorkflows(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/system/workflows", async (request, response) => {
    const body = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, false, async (context, canEdit) => {
      const data = await load(context)
      const permissions = (await context.client.query<{ code: string; description: string }>("SELECT code,description FROM permissions ORDER BY code")).rows.map(p => ({ code: p.code, description: p.description }))
      return { tenantId: context.tenantId, data, permissions, canEdit }
    })
    return reply(response, 200, body)
  })

  app.post("/api/v1/system/workflows", async (request, response) => {
    const { body, revision } = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
      const input = validate(parseBody(inputSchema, request.body, title))
      const exists = await context.client.query("SELECT 1 FROM system_config.workflow_definitions WHERE tenant_id=$1 AND code=$2 AND version=$3", [context.tenantId, input.code, input.version])
      if (exists.rows.length) throw conflict("Já existe esta versão do fluxo")
      const id = randomUUID()
      await context.client.query("INSERT INTO system_config.workflow_definitions(tenant_id,id,code,version,name) VALUES($1,$2,$3,$4,$5)", [context.tenantId, id, input.code, input.version, input.name])
      await replaceChildren(context, id, input)
      await record(context, request.headers, "workflow", id, "workflow.created", { code: input.code, version: input.version })
      const data = (await load(context, id))[0]
      if (!data) throw notFound()
      return { body: { tenantId: context.tenantId, data }, revision: data.revision }
    })
    return reply(response, 201, body, revision)
  })

  app.put<{ Params: { id: string } }>("/api/v1/system/workflows/:id", async (request, response) => {
    const expected = parseRevision(request.headers["if-match"])
    const { body, revision } = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
      const input = validate(parseBody(inputSchema, request.body, title))
      const id = request.params.id
      if (!validId(id)) throw notFound()
      const current = (await context.client.query<{ code: string; version: number; status: string; revision: number | string }>("SELECT code,version,status,revision FROM system_config.workflow_definitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
      if (!current) throw notFound()
      if (current.status !== "draft") throw conflict("Somente rascunhos podem ser editados")
      if (BigInt(current.revision) !== BigInt(expected)) throw staleRevision()
      if (current.code !== input.code || current.version !== input.version) throw invalid("Código e versão não podem ser alterados")
      await context.client.query("UPDATE system_config.workflow_definitions SET name=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, input.name])
      await replaceChildren(context, id, input)
      await record(context, request.headers, "workflow", id, "workflow.updated", { revision: BigInt(expected) + 1n })
      const data = (await load(context, id))[0]
      if (!data) throw notFound()
      return { body: { tenantId: context.tenantId, data }, revision: data.revision }
    })
    return reply(response, 200, body, revision)
  })

  for (const [action, target, event] of [["publish", "published", "workflow.published"], ["archive", "archived", "workflow.archived"]] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/system/workflows/:id/${action}`, async (request, response) => {
      const expected = parseRevision(request.headers["if-match"])
      const { body, revision } = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
        const id = request.params.id
        if (!validId(id)) throw notFound()
        const current = (await context.client.query<{ code: string; status: string; revision: number | string }>("SELECT code,status,revision FROM system_config.workflow_definitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
        if (!current) throw notFound()
        if (BigInt(current.revision) !== BigInt(expected)) throw staleRevision()
        if ((target === "published" && current.status !== "draft") || (target === "archived" && current.status !== "published")) throw conflict("Transição de situação não permitida")
        if (target === "published") {
          const other = await context.client.query("SELECT 1 FROM system_config.workflow_definitions WHERE tenant_id=$1 AND code=$2 AND status='published' AND id<>$3", [context.tenantId, current.code, id])
          if (other.rows.length) throw conflict("Arquive a versão publicada antes de publicar outra")
        }
        const changed = await context.client.query("UPDATE system_config.workflow_definitions SET status=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND revision=$4 RETURNING id", [context.tenantId, id, target, expected])
        if (!changed.rows.length) throw staleRevision()
        await record(context, request.headers, "workflow", id, event, { status: target, revision: BigInt(expected) + 1n })
        const data = (await load(context, id))[0]
        if (!data) throw notFound()
        return { body: { tenantId: context.tenantId, data }, revision: data.revision }
      })
      return reply(response, 200, body, revision)
    })
  }
}
