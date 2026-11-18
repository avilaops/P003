import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { authorizeRequest, requirePermission, type AccessDependencies } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"

export const paging = {
  q: z.string().trim().max(200).default(""),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(2147483647).default(0),
}
const environment = z.enum(["production", "homologation"])
const filters = z.strictObject({
  ...paging, model: z.enum(["55", "65"]), environment: environment.optional(),
  status: z.enum(["draft", "issued", "preparing", "prepared", "unknown", "authorized", "rejected", "cancelled"]).optional(),
})

// Match and count lightweight rows first. Read XML totals and item detail only for the requested page.
const listSql = `
WITH notes AS (
  SELECT d.id::text, 'internal' AS origin, d.environment, coalesce(e.status,'draft') AS status,
      e.number, e.series, coalesce(e.issued_at::timestamptz,d.created_at) AS date,
      d.details->'recipient'->>'legalName' AS recipient, d.details->'recipient'->>'taxId' AS "taxId",
      e.access_key AS "accessKey", e.result->>'reason' AS reason,
      coalesce(e.source_order_id::text,d.details->>'sourceOrderId',lot.order_id::text) AS "sourceOrderId",CASE WHEN NOT lot.legacy_full THEN lot.id END AS "lotId", d.model
    FROM fiscal_nfe_drafts d LEFT JOIN fiscal_nfe_documents e ON (e.tenant_id,e.id)=(d.tenant_id,d.id)
    LEFT JOIN sales_invoice_lots lot ON lot.tenant_id=d.tenant_id AND lot.draft_id=d.id
    WHERE d.tenant_id=$1 AND d.model=$2::int AND d.source_return_kind IS DISTINCT FROM 'sale_partial_return'
  UNION ALL
  SELECT i.id::text,'imported',CASE i.environment WHEN 1 THEN 'production' ELSE 'homologation' END,
      'authorized',i.number,i.series,i.issued_at,i.recipient_name,i.recipient_document,i.access_key,NULL,NULL,NULL,55
    FROM fiscal_outgoing_imports i WHERE i.tenant_id=$1 AND $2::int=55 AND NOT EXISTS (
      SELECT 1 FROM fiscal_nfe_documents d WHERE d.tenant_id=i.tenant_id AND d.access_key=i.access_key
        AND d.environment=CASE i.environment WHEN 1 THEN 'production' ELSE 'homologation' END)
), filtered AS MATERIALIZED (
  SELECT * FROM notes WHERE ($3::text IS NULL OR environment=$3)
    AND ($4::text IS NULL OR status=$4 OR ($4='issued' AND status <> 'draft'))
    AND ($5::date IS NULL OR date >= ($5::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($6::date IS NULL OR date < (($6::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($7='' OR strpos(lower(concat_ws(' ',recipient,"taxId",id,number,"accessKey")),lower($7))>0
      OR (length(regexp_replace($7,'[^0-9]','','g'))>=11 AND strpos("taxId",regexp_replace($7,'[^0-9]','','g'))>0))
), page AS (
  SELECT * FROM filtered ORDER BY date DESC,origin,id DESC LIMIT $8 OFFSET $9
), details AS (
  SELECT p.*,o.number::text AS "orderNumber", coalesce(
      nullif((xpath('string(/n:nfeProc/n:NFe/n:infNFe/n:total/n:ICMSTot/n:vNF)',xmlparse(document e.authorized_xml),
          ARRAY[ARRAY['n','http://www.portalfiscal.inf.br/nfe']]))[1]::text,'')::numeric,
      imp.total_cents/100::numeric,
      (SELECT sum(net + round(net*coalesce(nullif(d.details->'taxDeclaration'->>'ipiRate','')::numeric,0)/100,2))
         FROM (SELECT coalesce((item->>'grossTotal')::numeric,round((item->>'quantity')::numeric*(item->>'unitPrice')::numeric,2))
                 + coalesce((item->>'freightAmount')::numeric,0) + coalesce((item->>'insuranceAmount')::numeric,0)
                 + coalesce((item->>'otherAmount')::numeric,0) - coalesce((item->>'discountAmount')::numeric,0) AS net
               FROM jsonb_array_elements(d.details->'items') item) costs),
      d.products_total_cents/100::numeric)::numeric(18,2)::text AS amount
    FROM page p LEFT JOIN fiscal_nfe_drafts d ON p.origin='internal' AND d.tenant_id=$1 AND d.id::text=p.id
    LEFT JOIN fiscal_nfe_documents e ON e.tenant_id=d.tenant_id AND e.id=d.id
    LEFT JOIN fiscal_outgoing_imports imp ON p.origin='imported' AND imp.tenant_id=$1 AND imp.id::text=p.id
    LEFT JOIN sales_orders o ON o.tenant_id=$1 AND o.id::text=p."sourceOrderId"
)
SELECT (SELECT count(*)::int FROM filtered) AS total,
       coalesce(jsonb_agg(to_jsonb(details) ORDER BY date DESC,origin,id DESC),'[]') AS data FROM details`

export function registerFiscalOutgoing(app: FastifyInstance, deps: AccessDependencies) {
  app.get("/api/v1/fiscal/outgoing-documents", async (request, reply) => authorizeRequest(request,deps, async context => {
    requirePermission(context,"fiscal.nfe.read")
    const input = filters.safeParse(request.query)
    if (!input.success || input.data.from && input.data.to && input.data.from > input.data.to)
      throw new Problem(422,"invalid_input","Confira o modelo, o período e os filtros fiscais")
    const { model, environment, status, from, to, q, limit, offset } = input.data
    const page = (await context.client.query(listSql,[context.tenantId,model,environment,status,from,to,q,limit,offset])).rows[0]
    return reply.header("cache-control","no-store").send({ tenantId: context.tenantId, ...page })
  }))
  app.get("/api/v1/fiscal/nfce-readiness", async (request,reply) => authorizeRequest(request,deps,async context => {
    requirePermission(context,"fiscal.nfe.read")
    const input = z.strictObject({environment}).safeParse(request.query)
    if (!input.success) throw new Problem(422,"invalid_input","Informe o ambiente da NFC-e")
    const ambient = input.data.environment
    const config = (await context.client.query<{ configured: boolean; numbering: boolean }>(`
      SELECT data->>'environment'=$2 AND data->>'state'='SP' AND data->'cscConfigured'='true'::jsonb
        AND secret_key_id IS NOT NULL AND secret_ciphertext IS NOT NULL AND secret_nonce IS NOT NULL
        AND starts_with(secret_context,concat('avila-erp:nfce-csc:v1:',p.tenant_id,':',t.tax_id,':',$2::text,':',data->>'cscId',':')) AS configured,
        (data->>'series')::int BETWEEN 1 AND 999 AND coalesce(s.next_number,(data->>'nextNumber')::bigint) BETWEEN 1 AND 999999999 AS numbering
      FROM fiscal_preferences p JOIN tenants t ON t.id=p.tenant_id
      LEFT JOIN fiscal_number_sequences s ON s.tenant_id=p.tenant_id AND s.environment=$2 AND s.model=65 AND s.series=(p.data->>'series')::int
      WHERE p.tenant_id=$1 AND section='nfce'`,[context.tenantId,ambient])).rows[0]
    const blockers: string[] = []
    if (!config?.configured) blockers.push("nfce_csc_unavailable")
    if (!config?.numbering) blockers.push("nfce_numbering_unavailable")
    return reply.header("cache-control","no-store").send({ tenantId:context.tenantId, model:65, environment:ambient, blockers })
  }))
}
