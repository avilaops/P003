// Notas recebidas para o app Lojas, autenticado por chave de integração da empresa (não por usuário).
import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { authorizeServiceRequest } from "../../platform/service-auth.js"
import { renderDanfe, sha256 } from "../nfe-email/danfe.js"
import { signedId } from "../fiscal-incoming/received.js"

const base = "/api/v1/notas-recebidas"
/** Rotas autenticadas pela chave de integração: o `onRequest` de `buildApp` não exige login de usuário nelas. */
export const lojasServiceRoute = (method: string, url: string) => method === "GET" && (url === base || url === base + "/:id/xml" || url === base + "/:id/danfe")

type Stored = { access_key: string; issuer_document: string; environment: number; xml: string; xml_sha256: string }
async function stored(c: AuthorizedContext, raw: string) {
  const row = (await c.client.query<Stored>("SELECT access_key,issuer_document,environment,xml,xml_sha256 FROM fiscal_received_nfes WHERE tenant_id=$1 AND id=$2", [c.tenantId, signedId(raw)])).rows[0]
  if (!row) throw new Problem(404, "received_nfe_not_found", "Nota fiscal não encontrada nesta empresa")
  if (sha256(row.xml) !== row.xml_sha256) throw new Problem(409, "document_conflict", "A integridade do XML armazenado não foi confirmada")
  return row
}

export function registerLojasNotes(app: FastifyInstance, deps: AppDependencies, render = renderDanfe) {
  app.get(base, { config: { openapi: { summary: "Notas recebidas e resumos pendentes (chave de integração)" } } }, async (req, reply) => {
    const body = await authorizeServiceRequest(req, deps.pool, async c => {
      const notas = (await c.client.query(`SELECT id,access_key,number,series,issued_at,total_cents,item_count,issuer_document,issuer_name FROM fiscal_received_nfes
        WHERE tenant_id=$1 ORDER BY issued_at DESC,id DESC`, [c.tenantId])).rows.map(row => ({
        id: BigInt(String(row.id)), chave: row.access_key, numero: BigInt(String(row.number)), serie: row.series, emitida_em: row.issued_at,
        valor: Number(row.total_cents) / 100, itens: row.item_count, compra_id: null,
        fornecedor: { documento: row.issuer_document, nome: row.issuer_name, vinculado: false, id: null },
      }))
      const pendencias = (await c.client.query(`SELECT jsonb_build_object('nsu',d.nsu,'chave',d.access_key,'emitida_em',d.issued_at,'valor',d.total_cents::numeric/100,
        'situacao',CASE d.situation WHEN '1' THEN 'Autorizada' WHEN '2' THEN 'Denegada' ELSE 'Cancelada' END,'fornecedor',jsonb_build_object('documento',d.issuer_document,'nome',d.issuer_name)) AS item
        FROM fiscal_monitor_documents d WHERE d.tenant_id=$1 AND d.kind='summary'
        AND NOT EXISTS(SELECT 1 FROM fiscal_received_nfes n WHERE n.tenant_id=d.tenant_id AND n.access_key=d.access_key)
        AND NOT EXISTS(SELECT 1 FROM fiscal_monitor_documents newer WHERE newer.tenant_id=d.tenant_id AND newer.access_key=d.access_key AND newer.nsu>d.nsu AND newer.kind='summary')
        ORDER BY d.nsu DESC`, [c.tenantId])).rows.map(row => row.item)
      return { notas, pendencias }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  for (const format of ["xml", "danfe"] as const) app.get<{ Params: { id: string } }>(base + "/:id/" + format, { config: { openapi: { summary: format === "xml" ? "XML original da NF-e recebida" : "DANFE gerado do XML armazenado, sem consulta à SEFAZ" } } }, async (req, reply) => {
    const note = await authorizeServiceRequest(req, deps.pool, c => stored(c, req.params.id))
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff").header("x-xml-sha256", note.xml_sha256)
    if (format === "xml") return reply.type("application/xml; charset=utf-8").header("content-disposition", `attachment; filename="NFE-${note.access_key}.xml"`).send(note.xml)
    const pdf = await render({ issuerTaxId: note.issuer_document, xml: note.xml, accessKey: note.access_key, environment: note.environment === 1 ? "production" : "homologation" })
    // A chave pode ter sido revogada durante a geração externa: confere de novo antes de devolver o PDF.
    await authorizeServiceRequest(req, deps.pool, async () => undefined)
    return reply.type("application/pdf").header("content-disposition", `attachment; filename="DANFE-${note.access_key}.pdf"`)
      .header("x-pdf-sha256", sha256(pdf)).header("x-nfe-authorization-check", "xml-protocol-only").header("x-nfe-environment", String(note.environment)).send(pdf)
  })
}
