import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { validateDate } from "../sales/fixed.js"
import type { CommandHeaders } from "./receivables.js"

const maxBytes = 10 * 1024 * 1024
export const uploadLimit = Math.ceil(maxBytes / 3) * 4 + 32768
export const supportingInput = z.strictObject({
  filename: z.string().trim().min(1).max(180).refine(v => !/[\p{Cc}/\\:]/u.test(v) && ![".", ".."].includes(v)),
  mediaType: z.enum(["application/pdf","image/png","image/jpeg"]),
  contentBase64: z.string().min(4).max(Math.ceil(maxBytes / 3) * 4),
  description: z.string().trim().min(3).max(2000).refine(v => !/\p{Cc}/u.test(v)),
  documentDate: z.string().nullish().transform(v => v ? validateDate(v) : null),
})
const columns = `id,order_id AS "orderId",payment_id AS "paymentId",filename,media_type AS "mediaType",byte_size::int AS "byteSize",
  sha256,description,document_date::text AS "documentDate",uploaded_at::text AS "uploadedAt",uploaded_by AS "uploadedBy"`
export const orderId = (id:string) => {
  if (!z.guid().safeParse(id).success) throw new Problem(422,"invalid_input","Identificador inválido")
  return id.toLowerCase()
}
export const missing = () => new Problem(404,"not_found","Registro não encontrado")
export const stale = () => new Problem(412,"stale_revision","Os dados foram alterados. Atualize a consulta")
export async function orderHead(c:AuthorizedContext,id:string,lock=false) {
  const row=(await c.client.query<{status:string;revision:string;amount_cents:string}>("SELECT status,revision,amount_cents FROM sales_orders WHERE tenant_id=$1 AND id=$2"+(lock?" FOR SHARE":""),[c.tenantId,id])).rows[0]
  if(!row) throw missing()
  return row
}
function rights(c:AuthorizedContext) {
  const sales = c.permissions.includes("sales.orders.read"), finance = c.permissions.includes("finance.receivables.read")
  if(!sales&&!finance) requirePermission(c,"sales.orders.read")
  return {sales,finance,canAttachOther:sales&&c.permissions.includes("sales.orders.manage"),canAttachPayment:finance&&c.permissions.includes("finance.receivables.manage")}
}
export function prepareDocument(input:z.infer<typeof supportingInput>) {
  const {contentBase64,...metadata}=input, content=Buffer.from(contentBase64,"base64")
  const types={
    "application/pdf": {name:/\.pdf$/i,magic:Buffer.from("%PDF-")},
    "image/png": {name:/\.png$/i,magic:Buffer.from("89504e470d0a1a0a","hex")},
    "image/jpeg": {name:/\.jpe?g$/i,magic:Buffer.from("ffd8ff","hex")},
  }
  const rule=types[input.mediaType]
  if(!content.length||content.length>maxBytes||content.toString("base64")!==contentBase64||!rule.name.test(input.filename)||!content.subarray(0,rule.magic.length).equals(rule.magic)) throw new Problem(422,"invalid_input","Confira o conteúdo, o tipo e a extensão do arquivo")
  return {content,metadata:{...metadata,byteSize:content.length,sha256:createHash("sha256").update(content).digest("hex")}}
}
export async function saveDocument(c:AuthorizedContext,headers:CommandHeaders,order:string,payment:string|null,doc:ReturnType<typeof prepareDocument>) {
  const receivable=payment?(await c.client.query("SELECT p.receivable_id FROM receivable_payments p JOIN receivables r ON r.tenant_id=p.tenant_id AND r.id=p.receivable_id WHERE p.tenant_id=$1 AND p.id=$2 AND r.order_id=$3 AND p.kind='receipt'",[c.tenantId,payment,order])).rows[0]:null
  if(payment&&!receivable) throw missing()
  const m=doc.metadata, id=randomUUID()
  const stored=(await c.client.query(`INSERT INTO order_supporting_documents(id,tenant_id,order_id,receivable_id,payment_id,filename,media_type,byte_size,sha256,description,document_date,uploaded_by,content)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING `+columns,[id,c.tenantId,order,receivable?.receivable_id??null,payment,m.filename,m.mediaType,m.byteSize,m.sha256,m.description,m.documentDate,c.authSubject,doc.content])).rows[0]!
  await record(c,headers,"supporting_document",id,"order.document_attached",{orderId:order,paymentId:payment,sha256:m.sha256,byteSize:m.byteSize})
  return stored
}
export function registerSupportingDocuments(app:FastifyInstance,deps:AccessDependencies) {
  const path="/api/v1/orders/:id/documents"
  app.get<{Params:{id:string}}>(path,async(req,reply)=>{
    const order=orderId(req.params.id)
    const result=await authorizeRequest(req,deps,async c=>{
      const {sales,finance,canAttachOther,canAttachPayment}=rights(c)
      await orderHead(c,order)
      const rows=await c.client.query("SELECT "+columns+" FROM order_supporting_documents WHERE tenant_id=$1 AND order_id=$2 AND ((payment_id IS NULL AND $3) OR (payment_id IS NOT NULL AND $4)) ORDER BY uploaded_at,id",[c.tenantId,order,sales,finance])
      return {tenantId:c.tenantId,orderId:order,canAttachOther,canAttachPayment,data:rows.rows}
    })
    return reply.header("cache-control","no-store").send(result)
  })
  app.post<{Params:{id:string}}>(path,{bodyLimit:uploadLimit},async(req,reply)=>{
    const order=orderId(req.params.id), key=commandKey(req.headers["idempotency-key"])
    const result=await authorizeRequest(req,deps,async c=>{
      const access=rights(c), parsed=z.strictObject({paymentId:z.guid().toLowerCase().nullish(),document:supportingInput}).safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Documento inválido")
      const payment=parsed.data.paymentId??null
      if(!(payment?access.canAttachPayment:access.canAttachOther)) throw new Problem(403,"forbidden","Sem permissão para anexar este documento")
      await orderHead(c,order)
      const doc=prepareDocument(parsed.data.document), input={orderId:order,paymentId:payment,document:doc.metadata}
      const prior=await replay(c,key,"order.document.attach",input)
      if(prior) return prior
      const data=await saveDocument(c,req.headers,order,payment,doc), body={tenantId:c.tenantId,orderId:order,data}
      await remember(c,key,"order.document.attach",input,body)
      return body
    })
    return reply.code(201).header("etag",'"'+(result.data as {sha256:string}).sha256+'"').header("cache-control","no-store").send(result)
  })
  app.get<{Params:{id:string;documentId:string}}>(path+"/:documentId",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      const access=rights(c), row=(await c.client.query<{filename:string;content:Buffer;media_type:string;payment_id:string|null}>("SELECT filename,content,media_type,payment_id FROM order_supporting_documents WHERE tenant_id=$1 AND order_id=$2 AND id=$3",[c.tenantId,orderId(req.params.id),orderId(req.params.documentId)])).rows[0]
      if(!row) throw missing()
      if(!(row.payment_id?access.finance:access.sales)) throw new Problem(403,"forbidden","Sem permissão para consultar este documento")
      return row
    })
    const encoded=encodeURIComponent(result.filename).replace(/['()*]/g,v=>"%"+v.charCodeAt(0).toString(16))
    return reply.type(result.media_type).header("cache-control","private, no-store").header("x-content-type-options","nosniff").header("content-disposition","attachment; filename*=UTF-8''"+encoded).send(result.content)
  })
}
