import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AccessDependencies } from "../../platform/access.js"
import { queryInteger } from "../registrations/query.js"
import { parse, readWith } from "./shared.js"

const filters=z.strictObject({
  from:z.iso.date().optional(),to:z.iso.date().optional(),offset:queryInteger(0,1000000).default(0)
}).refine(f=>!f.from || !f.to || f.from<=f.to)
const population=`WITH cases AS (
  SELECT c.id,c.protocol,c.title,c.created_at,c.status,c.sla_due_at AS sla,
    EXISTS(SELECT FROM warranty_cases old WHERE old.tenant_id=c.tenant_id AND (old.created_at,old.id)<(c.created_at,c.id) AND
      (c.equipment_id IS NOT NULL AND old.equipment_id=c.equipment_id OR nullif(trim(c.serial_number),'') IS NOT NULL AND upper(trim(old.serial_number))=upper(trim(c.serial_number)))) AS repeated,
    (SELECT min(t.created_at) FROM warranty_case_events t WHERE t.tenant_id=c.tenant_id AND t.case_id=c.id AND t.event_type='closed') AS closed_at,
    (SELECT r.info->>'cause' FROM warranty_case_records r WHERE r.tenant_id=c.tenant_id AND r.case_id=c.id AND r.kind='report' ORDER BY r.created_at DESC,r.id LIMIT 1) AS cause,
    (SELECT coalesce(sum(s.labor_cents),0) FROM warranty_service_orders s WHERE s.tenant_id=c.tenant_id AND s.case_id=c.id)
    + (SELECT coalesce(sum(p.amount_cents),0) FROM warranty_service_orders s JOIN warranty_service_order_parts p ON p.tenant_id=s.tenant_id AND p.service_order_id=s.id WHERE s.tenant_id=c.tenant_id AND s.case_id=c.id) AS cost,
    (SELECT coalesce(sum(w.amount_cents),0) FROM warranty_settlements w WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.kind='supplier_cash') AS recovery,
    (SELECT coalesce(sum(w.quantity_micros),0) FROM warranty_settlements w WHERE w.tenant_id=c.tenant_id AND w.case_id=c.id AND w.kind='supplier_stock') AS recovered_units
  FROM warranty_cases c WHERE c.tenant_id=$1
    AND ($2::date IS NULL OR c.created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($3::date IS NULL OR c.created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
) `
export function registerWarrantyMetrics(app:FastifyInstance,deps:AccessDependencies) {
  app.get("/api/v1/warranty-metrics",async(req,reply)=>reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx=>{
    const f=parse(filters,req.query)
    const row=(await ctx.client.query(population+`SELECT count(*)::int AS total,count(*) FILTER(WHERE repeated)::int AS repeated,
        count(closed_at)::int AS closed,round(avg(extract(epoch FROM closed_at-created_at))/3600,1)::text AS "meanHours",
        count(*) FILTER(WHERE sla < now() AND status NOT IN ('resolved','closed','cancelled'))::int AS overdue,
        coalesce(sum(cost),0)::text AS "costCents",coalesce(sum(recovery),0)::text AS "recoveryCents",
        coalesce(sum(recovered_units),0)::text AS "recoveredMicros",
        (SELECT coalesce(jsonb_agg(to_jsonb(causes) ORDER BY n DESC,cause),'[]') FROM
          (SELECT cause,count(*)::int AS n FROM cases GROUP BY cause) causes) AS causes,
        (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.opened DESC,p.id DESC),'[]') FROM
          (SELECT id,protocol,title,created_at AS opened,repeated,cost::text AS "costCents",recovery::text AS "recoveryCents" FROM cases ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $4) p) AS data
        FROM cases`,[ctx.tenantId,f.from??null,f.to??null,f.offset])).rows[0]
    return {...row,offset:f.offset}
  })))
}
