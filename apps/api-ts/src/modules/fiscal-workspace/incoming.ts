import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { authorizeRequest, requirePermission, type AuthorizedContext, type AccessDependencies } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { renderDanfe, sha256 } from "../nfe-email/danfe.js"
import { paging } from "./outgoing.js"

const query = z.strictObject({
  ...paging, purchase: z.enum(["linked","unlinked"]).optional(),
  salesReturn:z.enum(["linked","unlinked"]).optional(),
  manifestation: z.enum(["pending","accepted"]).optional(),
})
export const signedId = (value: unknown) => {
  const result = z.string().regex(/^[1-9]\d{0,18}$/).safeParse(value)
  if (!result.success || BigInt(result.data) > 9223372036854775807n) throw new Problem(422,"invalid_input","Número de registro inválido")
  return result.data
}
function requireReader(context: AuthorizedContext) {
  if (!context.permissions.includes("fiscal.received_nfe.manage")) requirePermission(context,"fiscal.monitor.read")
}
const fields = `n.id,n.access_key AS "accessKey",n.issuer_document AS "issuerDocument",n.issuer_name AS "issuerName",
  n.recipient_document AS "recipientDocument",n.number,n.series,n.issued_at AS "issuedAt",n.total_cents AS "totalCents",
  n.item_count AS "itemCount",n.environment,n.xml_sha256 AS "xmlSha256",n.created_at AS "createdAt"`
const notes = `SELECT ${fields},l.purchase_order_id AS "purchaseId",lot.order_id AS "returnOrderId",event.kind AS "manifestationKind",
    coalesce(event.outcome,'pending') AS manifestation
  FROM fiscal_received_nfes n LEFT JOIN fiscal_received_purchase_links l
    ON l.tenant_id=n.tenant_id AND l.received_nfe_id=n.id
  LEFT JOIN sales_partial_returns r ON r.tenant_id=n.tenant_id AND r.received_nfe_id=n.id
  LEFT JOIN sales_invoice_lots lot ON lot.tenant_id=r.tenant_id AND lot.id=r.lot_id
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT m.event_type AS kind,m.outcome,coalesce(m.completed_at,m.created_at) AS date
        FROM fiscal_monitor_manifestations m WHERE n.environment=1 AND m.tenant_id=n.tenant_id AND m.access_key=n.access_key
      UNION ALL SELECT m.kind,m.status,m.issued_at FROM fiscal_recipient_manifestations m
        WHERE n.environment=m.environment AND m.tenant_id=n.tenant_id AND m.access_key=n.access_key
    ) events ORDER BY date DESC,kind LIMIT 1
  ) event ON true WHERE n.tenant_id=$1`
const listSql = `WITH stored AS (${notes}
    AND ($2='' OR strpos(lower(concat_ws(' ',n.issuer_name,n.issuer_document,n.access_key,n.number)),lower($2))>0
      OR (length(regexp_replace($2,'[^0-9]','','g'))>=11 AND n.issuer_document=regexp_replace($2,'[^0-9]','','g')))
    AND ($3::date IS NULL OR n.issued_at >= ($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($4::date IS NULL OR n.issued_at < (($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
  ), filtered AS MATERIALIZED (
    SELECT * FROM stored WHERE ($5::text IS NULL OR ($5='linked')=("purchaseId" IS NOT NULL))
      AND ($6::text IS NULL OR ($6='accepted')=(manifestation='accepted'))
      AND ($9::text IS NULL OR ($9='linked')=("returnOrderId" IS NOT NULL))
  ), page AS (SELECT * FROM filtered ORDER BY "issuedAt" DESC,id DESC LIMIT $7 OFFSET $8)
  SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce(jsonb_agg(to_jsonb(page) ORDER BY "issuedAt" DESC,id DESC),'[]') AS data FROM page`

type Download = { xml:string; issuer:string; key:string; environment:number; digest:string }

export function registerFiscalIncoming(app: FastifyInstance, deps: AccessDependencies, render = renderDanfe) {
  const prefix = "/api/v1/fiscal/received-nfes"
  app.get(prefix, async (request,reply) => authorizeRequest(request,deps,async context => {
    requireReader(context)
    const input = query.safeParse(request.query)
    if (!input.success || input.data.from && input.data.to && input.data.from > input.data.to)
      throw new Problem(422,"invalid_input","Confira o período e os filtros das notas")
    const { q,from,to,purchase,manifestation,limit,offset,salesReturn } = input.data
    const page = (await context.client.query(listSql,[context.tenantId,q,from,to,purchase,manifestation,limit,offset,salesReturn])).rows[0]
    return reply.header("cache-control","no-store").send({ tenantId:context.tenantId,canImport:context.permissions.includes("fiscal.received_nfe.manage"),...page })
  }))
  app.get<{Params:{id:string}}>(prefix+"/:id", async (request,reply) => authorizeRequest(request,deps,async context => {
    requireReader(context)
    const id = signedId(request.params.id)
    const data = (await context.client.query(`SELECT to_jsonb(found) AS note FROM (${notes} AND n.id=$2) found`,[context.tenantId,id])).rows[0]
    if (!data) throw new Problem(404,"not_found","Nota não encontrada nesta empresa")
    return reply.header("cache-control","no-store").send({tenantId:context.tenantId,canManage:context.permissions.includes("fiscal.received_nfe.manage"),data:data.note})
  }))
  for (const format of ["xml","danfe"] as const) {
    app.get<{Params:{id:string}}>(prefix+"/:id/"+format, async (request,reply) => {
      const id = signedId(request.params.id)
      const read = async (context: AuthorizedContext) => {
        requireReader(context)
        const row = (await context.client.query<Download>(`SELECT xml,issuer_document AS issuer,access_key AS key,environment,xml_sha256 AS digest
          FROM fiscal_received_nfes WHERE tenant_id=$1 AND id=$2`,[context.tenantId,id])).rows[0]
        if (!row) throw new Problem(404,"not_found","Nota não encontrada nesta empresa")
        return row
      }
      const note = await authorizeRequest(request,deps,read)
      if (sha256(note.xml) !== note.digest) throw new Problem(409,"document_conflict","A integridade do XML armazenado não foi confirmada")
      const pdf = format === "danfe" ? await render({issuerTaxId:note.issuer,xml:note.xml,accessKey:note.key,
        environment:note.environment===1 ? "production" : "homologation"}) : undefined
      if (pdf) {
        // Recheck rights after an external render, before returning document bytes.
        await authorizeRequest(request,deps,async context => { requireReader(context) })
        reply.header("x-pdf-sha256",sha256(pdf))
      }
      return reply.header("cache-control","no-store").header("x-content-type-options","nosniff")
        .header("x-xml-sha256",note.digest).header("x-nfe-environment",String(note.environment))
        .header("content-disposition",`attachment; filename="${pdf ? "DANFE" : "NFE"}-${note.key}.${pdf ? "pdf" : "xml"}"`)
        .type(pdf ? "application/pdf" : "application/xml; charset=utf-8").send(pdf ?? note.xml)
    })
  }
}
