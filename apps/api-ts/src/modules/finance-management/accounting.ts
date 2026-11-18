import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission } from "../../platform/access.js"
import { revisionValue } from "../../platform/revision.js"
import { record } from "../../platform/commands.js"
import { recoverAccountingHistory } from "./history.js"
import { eventTypes,manualReverse,pendingFilter,postPending } from "./journal.js"
import { accountingManage,accountingRead,checkRevision,command,conflict,date,invalid,missing,month,parse,reason,response,type Context } from "./shared.js"

const permissions=[accountingRead,accountingManage]
const accountSchema=z.strictObject({code:z.string().trim().regex(/^[0-9A-Za-z][.0-9A-Za-z_-]{0,39}$/),name:z.string().trim().min(2).max(150),classification:z.enum(["asset","liability","equity","revenue","expense"])})
const ruleSchema=z.strictObject({eventType:z.enum(eventTypes),debitId:z.guid(),creditId:z.guid()})
const periodSchema=z.strictObject({month,reason})
const reverseSchema=z.strictObject({occurredOn:date,reason})
const querySchema=z.strictObject({from:date,to:date,accountId:z.guid().optional(),format:z.enum(["json","csv"]).default("json")})
async function snapshot(c:Context) {
  const {client,tenantId}=c
  const accounts=(await client.query("SELECT id,code,name,classification FROM accounting_accounts WHERE tenant_id=$1 ORDER BY code",[tenantId])).rows
  const rules=(await client.query('SELECT event_type AS "eventType",debit_id AS "debitId",credit_id AS "creditId" FROM accounting_rules WHERE tenant_id=$1 ORDER BY event_type',[tenantId])).rows
  const periods=(await client.query(`SELECT to_char(month,'YYYY-MM') AS month,closed,reason,changed_by AS "changedBy" FROM accounting_periods WHERE tenant_id=$1 ORDER BY month DESC`,[tenantId])).rows
  const pending=(await client.query(`SELECT event_type AS "eventType",count(*)::int AS count FROM accounting_events e WHERE tenant_id=$1 AND ${pendingFilter} GROUP BY event_type ORDER BY event_type`,[tenantId])).rows
  const fiscal=(await client.query("SELECT count(*)::int AS count FROM finance_invoice_events WHERE tenant_id=$1 AND NOT processed",[tenantId])).rows[0]!.count
  const revision=(await client.query("SELECT revision FROM accounting_settings WHERE tenant_id=$1",[tenantId])).rows[0]?.revision ?? 1
  return {tenantId,canEdit:c.permissions.includes(accountingManage),data:{revision:revisionValue(revision)},accounts,rules,periods,pending,pendingInvoices:fiscal,eventTypes}
}
type Report = "journal"|"ledger"|"trial-balance"
async function report(c:Context,kind:Report,from:string,to:string,account?:string) {
  const parameters=[c.tenantId,from,to,account ?? null]
  const journal=`SELECT j.id,j.occurred_on AS day,j.amount_cents,j.debit_id,j.credit_id,j.memo,j.reverses_entry_id,
    d.code AS debit_code,d.name AS debit_name,k.code AS credit_code,k.name AS credit_name,
    e.event_type,e.source_id,e.document_type,e.document_id
    FROM accounting_entries j JOIN accounting_events e ON e.tenant_id=j.tenant_id AND e.id=j.event_id
    JOIN accounting_accounts d ON d.tenant_id=j.tenant_id AND d.id=j.debit_id
    JOIN accounting_accounts k ON k.tenant_id=j.tenant_id AND k.id=j.credit_id WHERE j.tenant_id=$1 AND j.occurred_on<=$3`
  const lines=`SELECT j.*,a.account_id,a.debit,a.credit FROM j CROSS JOIN LATERAL
    (VALUES (j.debit_id,j.amount_cents,0::bigint),(j.credit_id,0::bigint,j.amount_cents)) a(account_id,debit,credit) WHERE ($4::uuid IS NULL OR a.account_id=$4)`
  const fields=`id,day::text AS date,event_type AS "eventType",source_id AS "sourceId",document_type AS "documentType",document_id AS "documentId",memo,reverses_entry_id AS "reversesEntryId"`
  if(kind==="journal") return (await c.client.query(`WITH j AS (${journal}) SELECT ${fields},debit_code AS "debitAccount",debit_name AS "debitName",credit_code AS "creditAccount",credit_name AS "creditName",
    round(amount_cents/100.0,2)::text AS amount FROM j WHERE day>=$2 AND ($4::uuid IS NULL OR $4 IN(debit_id,credit_id)) ORDER BY day,id`,parameters)).rows
  if(kind==="ledger") return (await c.client.query(`WITH j AS (${journal}),lines AS (${lines}),
    balances AS (SELECT *,sum(debit-credit) OVER(PARTITION BY account_id ORDER BY day,id ROWS UNBOUNDED PRECEDING) AS balance FROM lines)
    SELECT ${fields},CASE WHEN account_id=debit_id THEN debit_code ELSE credit_code END AS account,
      round(debit/100.0,2)::text AS debit,round(credit/100.0,2)::text AS credit,
      round((balance-debit+credit)/100.0,2)::text AS opening,round(balance/100.0,2)::text AS balance
    FROM balances WHERE day>=$2 ORDER BY account,day,id`,parameters)).rows
  return (await c.client.query(`WITH j AS (${journal}),lines AS (${lines})
    SELECT a.code AS account,a.name,round(coalesce(sum(l.debit-l.credit) FILTER(WHERE l.day<$2),0)/100.0,2)::text AS opening,
    round(coalesce(sum(l.debit) FILTER(WHERE l.day>=$2),0)/100.0,2)::text AS debit,
    round(coalesce(sum(l.credit) FILTER(WHERE l.day>=$2),0)/100.0,2)::text AS credit,
    round(coalesce(sum(l.debit-l.credit),0)/100.0,2)::text AS balance
    FROM accounting_accounts a LEFT JOIN lines l ON l.account_id=a.id
    WHERE a.tenant_id=$1 AND ($4::uuid IS NULL OR a.id=$4) GROUP BY a.id,a.code,a.name ORDER BY a.code`,parameters)).rows
}
const reportColumns={journal:["id","date","eventType","sourceId","documentType","documentId","memo","reversesEntryId","debitAccount","debitName","creditAccount","creditName","amount"],ledger:["id","date","eventType","sourceId","documentType","documentId","memo","reversesEntryId","account","debit","credit","opening","balance"],"trial-balance":["account","name","opening","debit","credit","balance"]}
function csvValue(v:unknown) {
  let s=String(v ?? "")
  if(/^[\s]*[=+@-]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s="'"+s
  return '"'+s.replaceAll('"','""')+'"'
}
export function registerAccounting(app:FastifyInstance,deps:AppDependencies) {
  const base="/api/v1/accounting"
  app.get(base,async(req,reply)=>response(reply,await authorizeRequest(req,deps,async c=>{requirePermission(c,accountingRead);return snapshot(c)})))
  for(const kind of ["journal","ledger","trial-balance"] as const) app.get(base+"/reports/"+kind,async(req,reply)=>{
    const q=parse(querySchema,req.query)
    if(q.from>q.to) invalid("Data inicial posterior ao fim do período")
    const body=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,accountingRead)
      return {tenantId:c.tenantId,from:q.from,to:q.to,criterion:"Competência do lançamento",data:await report(c,kind,q.from,q.to,q.accountId)}
    })
    if(q.format==="json") return response(reply,body)
    const columns=reportColumns[kind]
    const rows=[["Empresa","De","Até",...columns],...body.data.map(row=>[body.tenantId,q.from,q.to,...columns.map(k=>row[k])])]
    return reply.header("cache-control","no-store").header("content-disposition",'attachment; filename="'+kind+"-"+q.from+".csv"+'"').type("text/csv; charset=utf-8").send("\uFEFF"+rows.map(row=>row.map(csvValue).join(";")).join("\r\n"))
  })
  for(const action of ["accounts","rules","sync","close","reopen","entries/:id/reverse"] as const) {
    app.post<{Params:{id?:string}}>(base+"/"+action,async(req,reply)=>{
      const id=req.params.id?parse(z.guid(),req.params.id):"accounting"
      const body=await command(req,deps,"accounting."+action,id,permissions,z.unknown(),async(c,payload,expected)=>{
        const {client,tenantId}=c
        await client.query("INSERT INTO accounting_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING",[tenantId])
        const rev=(await client.query("SELECT revision FROM accounting_settings WHERE tenant_id=$1 FOR UPDATE",[tenantId])).rows[0]!.revision
        checkRevision(rev,expected)
        let entity = tenantId
        if(action==="accounts") {
          const input=parse(accountSchema,payload)
          if((await client.query("SELECT 1 FROM accounting_accounts WHERE tenant_id=$1 AND code=$2",[tenantId,input.code])).rows.length) conflict("Já existe conta com este código")
          entity=randomUUID()
          await client.query("INSERT INTO accounting_accounts(tenant_id,id,code,name,classification) VALUES($1,$2,$3,$4,$5)",[tenantId,entity,input.code,input.name,input.classification])
        } else if(action==="rules") {
          const input=parse(ruleSchema,payload)
          if(input.debitId===input.creditId) invalid("Débito e crédito exigem contas distintas")
          if((await client.query("SELECT id FROM accounting_accounts WHERE tenant_id=$1 AND id IN ($2,$3)",[tenantId,input.debitId,input.creditId])).rows.length!==2) missing()
          await client.query(`INSERT INTO accounting_rules(tenant_id,event_type,debit_id,credit_id) VALUES($1,$2,$3,$4)
            ON CONFLICT(tenant_id,event_type) DO UPDATE SET debit_id=EXCLUDED.debit_id,credit_id=EXCLUDED.credit_id`,[tenantId,input.eventType,input.debitId,input.creditId])
        } else if(action==="sync") {
          parse(z.strictObject({}),payload)
          await recoverAccountingHistory(c,req.headers);await postPending(c,req.headers)
        } else if(action==="entries/:id/reverse") {
          const input=parse(reverseSchema,payload)
          await manualReverse(c,req.headers,id,input.occurredOn,input.reason);entity=id
        } else {
          const input=parse(periodSchema,payload),closed=action==="close",start=input.month+"-01"
          const wasClosed=!!(await client.query("SELECT closed FROM accounting_periods WHERE tenant_id=$1 AND month=$2",[tenantId,start])).rows[0]?.closed
          if(wasClosed===closed) conflict(closed?"Competência já encerrada":"Competência já aberta")
          if(closed) {
            await recoverAccountingHistory(c,req.headers);await postPending(c,req.headers)
            const pending=(await client.query(`SELECT 1 FROM accounting_events e WHERE tenant_id=$1 AND occurred_on>=$2::date AND occurred_on<$2::date+interval '1 month' AND ${pendingFilter} LIMIT 1`,[tenantId,start])).rows.length
            if(pending) conflict("Configure as regras dos eventos pendentes antes de encerrar a competência")
          }
          await client.query(`INSERT INTO accounting_periods(tenant_id,month,closed,reason,changed_by) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(tenant_id,month) DO UPDATE SET closed=EXCLUDED.closed,reason=EXCLUDED.reason,changed_by=EXCLUDED.changed_by`,[tenantId,start,closed,input.reason,c.authSubject])
        }
        await client.query("UPDATE accounting_settings SET revision=revision+1 WHERE tenant_id=$1",[tenantId])
        await record(c,req.headers,"accounting",entity,"accounting."+action.replace("entries/:id/reverse","manual_reversal"),payload)
        return snapshot(c)
      })
      return response(reply,body)
    })
  }
}
