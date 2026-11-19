import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { queryInteger } from "../registrations/query.js"
import { fixed, validateDate } from "../sales/fixed.js"
import { assertOpenAccountPeriod, conflict, invalid, missing, parse, textField } from "../finance-treasury/ledger.js"
import { checkRevision, command, response } from "../finance-management/shared.js"
import { accountBalance, move, movementSchema } from "./movement.js"
import { detail, expectedCash, summary } from "./snapshot.js"

const read = "sales.pos.read",
  manage = "sales.pos.manage",
  close = "sales.pos.close"
const openSchema = z.strictObject({ register: z.string(), cashAccountId: id, openingAmount: z.string() })
const closeSchema = z.strictObject({ countedCash: z.string(), reason: z.string().nullable().default(null) })
const register = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\p{Cc}]*$/u)
const listSchema = z.strictObject({
  register: z.string().optional(),
  status: z.enum(["open", "closed"]).optional(),
  startDate: z.string().transform(validateDate).optional(),
  endDate: z.string().transform(validateDate).optional(),
  offset: queryInteger(0, 100000).default(0),
  limit: queryInteger(1, 100).default(25),
})
const daySql = "SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date::text AS day"
export function registerPosSessionRoutes(app: FastifyInstance, deps: AppDependencies) {
  const base = "/api/v1/pos/sessions"
  app.get(base, async (req, reply) => {
    const q = parse(listSchema, req.query)
    if (q.startDate && q.endDate && q.startDate > q.endDate) throw invalid("Intervalo de datas inválido")
    return response(
      reply,
      await authorizeRequest(req, deps, async (c) => {
        requirePermission(c, read)
        const result = (
          await c.client.query(
            `WITH sessions AS (SELECT ${summary} FROM pos_sessions s WHERE s.tenant_id=$1
        AND ($2::text IS NULL OR s.status=$2) AND ($3::text IS NULL OR lower(s.register)=lower($3))
        AND ($4::date IS NULL OR (s.opened_at AT TIME ZONE 'America/Sao_Paulo')::date>=$4)
        AND ($5::date IS NULL OR (s.opened_at AT TIME ZONE 'America/Sao_Paulo')::date<=$5)),
        page AS (SELECT * FROM sessions ORDER BY "openedAt" DESC,id DESC LIMIT $6 OFFSET $7)
        SELECT (SELECT count(*)::int FROM sessions) AS total,coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."openedAt" DESC,p.id DESC) FROM page p),'[]') AS data`,
            [
              c.tenantId,
              q.status ?? null,
              q.register ?? null,
              q.startDate ?? null,
              q.endDate ?? null,
              q.limit,
              q.offset,
            ],
          )
        ).rows[0]!
        return {
          tenantId: c.tenantId,
          canEdit: c.permissions.includes(manage),
          ...result,
          offset: q.offset,
          limit: q.limit,
        }
      }),
    )
  })
  app.get(base + "/current", async (req, reply) => {
    const q = parse(z.strictObject({ register: z.string().optional() }), req.query)
    return response(
      reply,
      await authorizeRequest(req, deps, async (c) => {
        requirePermission(c, read)
        const current = (
          await c.client.query(
            "SELECT id FROM pos_sessions WHERE tenant_id=$1 AND status='open' AND ($2::text IS NULL OR lower(register)=lower($2)) ORDER BY opened_at DESC,id DESC LIMIT 1 FOR SHARE",
            [c.tenantId, q.register ?? null],
          )
        ).rows[0]
        return {
          tenantId: c.tenantId,
          canEdit: c.permissions.includes(manage),
          canClose: c.permissions.includes(close),
          data: current ? await detail(c, String(current.id)) : null,
        }
      }),
    )
  })
  app.get<{ Params: { id: string } }>(base + "/:id", async (req, reply) =>
    response(
      reply,
      await authorizeRequest(req, deps, async (c) => {
        requirePermission(c, read)
        return {
          tenantId: c.tenantId,
          canEdit: c.permissions.includes(manage),
          canClose: c.permissions.includes(close),
          data: await detail(c, parse(id, req.params.id)),
        }
      }),
    ),
  )
  app.post(base, async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"]),
      scope = "pos.open"
    const body = await authorizeRequest(req, deps, async (c) => {
      requirePermission(c, read)
      requirePermission(c, manage)
      const input = parse(openSchema, req.body),
        cached = await replay(c, key, scope, input)
      if (cached) return cached
      const name = parse(register, input.register),
        opening = fixed(input.openingAmount, 2)
      const cash = (
        await c.client.query(
          "SELECT id FROM financial_accounts WHERE tenant_id=$1 AND id=$2 AND status='active' AND account_type='cash' FOR UPDATE",
          [c.tenantId, input.cashAccountId],
        )
      ).rows[0]
      if (!cash) throw conflict("Selecione uma conta caixa ativa nesta empresa")
      const day = String((await c.client.query(daySql)).rows[0]!.day)
      await assertOpenAccountPeriod(c, input.cashAccountId, day)
      if ((await accountBalance(c, input.cashAccountId)) < opening)
        throw conflict("Fundo de abertura excede o saldo da conta caixa")
      const busy = await c.client.query(
        "SELECT id FROM pos_sessions WHERE tenant_id=$1 AND status='open' AND (lower(register)=lower($2) OR cash_account_id=$3)",
        [c.tenantId, name, input.cashAccountId],
      )
      if (busy.rows.length) throw conflict("Registro ou conta já possui caixa aberto")
      const session = randomUUID()
      await c.client.query(
        "INSERT INTO pos_sessions(tenant_id,id,register,cash_account_id,opening_cents,opened_by) VALUES($1,$2,$3,$4,$5,$6)",
        [c.tenantId, session, name, input.cashAccountId, opening, c.authSubject],
      )
      const value = {
        tenantId: c.tenantId,
        canEdit: true,
        canClose: c.permissions.includes(close),
        data: await detail(c, session),
      }
      await record(c, req.headers, "pos", session, scope, input)
      await remember(c, key, scope, input, value)
      return value
    })
    return response(reply, body, 201)
  })
  for (const action of ["movements", "close"] as const) {
    app.post<{ Params: { id: string } }>(base + "/:id/" + action, async (req, reply) => {
      const session = parse(id, req.params.id),
        closing = action === "close"
      const scope = closing ? "pos.close" : "pos.movement"
      const schema = z.unknown().transform((raw) => (closing ? parse(closeSchema, raw) : parse(movementSchema, raw)))
      const body = await command(
        req,
        deps,
        scope,
        session,
        [read, closing ? close : manage],
        schema,
        async (c, value, revision) => {
          const row = (
            await c.client.query(
              "SELECT revision,status,cash_account_id FROM pos_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [c.tenantId, session],
            )
          ).rows[0]
          if (!row) throw missing()
          checkRevision(row.revision, revision)
          if (row.status !== "open") throw conflict("Caixa fechado não aceita alterações")
          const cash = String(row.cash_account_id),
            day = String((await c.client.query(daySql)).rows[0]!.day)
          await assertOpenAccountPeriod(c, cash, day)
          if ("countedCash" in value) {
            const counted = fixed(value.countedCash, 2),
              expected = await expectedCash(c, session)
            const reason = value.reason === null ? null : parse(textField(3, 500), value.reason)
            if (counted !== expected && !reason)
              throw invalid("Justifique a diferença entre dinheiro contado e esperado")
            await c.client.query(
              "UPDATE pos_sessions SET status='closed',closed_at=clock_timestamp(),counted_cents=$3,close_reason=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
              [c.tenantId, session, counted, reason],
            )
          } else await move(c, session, cash, day, value)
          const request = { id: session, revision, input: value }
          await record(c, req.headers, "pos", session, scope, request)
          return {
            tenantId: c.tenantId,
            canEdit: !closing,
            canClose: c.permissions.includes(close),
            data: await detail(c, session),
          }
        },
      )
      return response(reply, body)
    })
  }
}
