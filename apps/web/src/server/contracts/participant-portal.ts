import "server-only"

import { documentsPage, entryPage, messagePage, responseHeaders, type SigningFile } from "./participant-page"
import { createHash } from "node:crypto"

const publicOrigin = "https://contrato.avilaops.com"
const sessionName = "__Secure-avila_icp"
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const revisionPattern = /^[1-9]\d{0,18}:[1-9]\d{0,18}:[a-f0-9]{64}$/
const maxFile = 32 * 1024 * 1024
type Params = { tenant: string; id: string; action?: string[] }
class BoundaryError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

function cookie(request: Request, name: string, pattern: RegExp) {
  const matches = (request.headers.get("cookie") || "").split(";").map(value => value.trim()).filter(value => value.startsWith(name + "="))
  const value = matches[0]?.slice(name.length + 1)
  return matches.length === 1 && value && pattern.test(value) ? value : undefined
}
async function bounded(message: Request | Response, max: number) {
  const length = message.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
    throw new BoundaryError(413, "O arquivo excede o limite permitido.")
  const reader = message.body?.getReader()
  if (!reader) throw new BoundaryError(422, "O arquivo ou a resposta está vazio.")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) { await reader.cancel(); throw new BoundaryError(413, "O arquivo excede o limite permitido.") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  if (length !== null && Number(length) !== size) throw new BoundaryError(422, "A transferência ficou incompleta. Tente novamente.")
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of chunks) { bytes.set(part, offset); offset += part.length }
  return bytes
}
async function json(response: Response) {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new Error("invalid_response")
  return JSON.parse(new TextDecoder().decode(await bounded(response, 16 * 1024)))
}
function knownFiles(raw: unknown): raw is SigningFile[] {
  return Array.isArray(raw) && raw.length >= 1 && raw.length <= 10 && new Set(raw.map(f => f?.id)).size === raw.length &&
    raw.every(f => f && typeof f.id === "string" && idPattern.test(f.id) && typeof f.filename === "string" && f.filename.length <= 180 &&
      Number.isInteger(f.position) && f.position >= 1 && f.position <= 10 && typeof f.done === "boolean" &&
      /^[1-9]\d{0,18}$/.test(f.stageRevision) && /^[1-9]\d{0,18}$/.test(f.headRevision) && /^[a-f0-9]{64}$/.test(f.parentSha256))
}
function pdf(bytes: Uint8Array) { return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" }
function errorStatus(status: number) { return [400,401,403,404,409,412,413,422,428,429].includes(status) ? status : 503 }
function apiProblem(status: number) {
  if (status === 401 || status === 403) return "Abra o convite original, confirme seu e-mail no portal e aguarde sua vez de assinar."
  if (status === 409 || status === 412 || status === 428) return "A etapa mudou. Confira a lista e baixe a versão atual para assinar."
  if (status === 422) return "O PDF não passou na validação da assinatura. Confira o titular do e-CPF e a versão que foi assinada."
  if (status === 413) return "Escolha um PDF de até 32 MiB."
  if (status === 429) return "Aguarde um momento antes de tentar novamente."
  return "Não foi possível confirmar a operação. Consulte os documentos antes de tentar novamente."
}
async function successful(response: Response) {
  if (response.ok) return response
  await response.body?.cancel()
  const status = errorStatus(response.status)
  throw new BoundaryError(status, apiProblem(status))
}

export async function participantPortal(request: Request, params: Params, backend: () => string, http: typeof fetch = fetch) {
  const { tenant, id, action = [] } = params
  const absent = () => new Response(null, { status: 404, headers: responseHeaders })
  if (request.headers.get("host")?.toLowerCase() !== "contrato.avilaops.com" || !idPattern.test(tenant) || !idPattern.test(id) || new URL(request.url).search) return absent()
  const base = `/icp/${tenant}/${id}`
  if (request.method !== "GET" && (request.method !== "POST" || request.headers.get("origin") !== publicOrigin))
    return new Response(null, { status: 403, headers: responseHeaders })
  const token = cookie(request, sessionName, /^[A-Za-z0-9_-]{43}$/)
  const verification = cookie(request, "email_2fa_slug", /^[A-Za-z0-9%+/_=.-]{1,4096}$/)
  const [op, doc] = action
  const session = "/session", document = "/documents/" + doc
  const call = (path: string, init: RequestInit = {}) => http(new URL(`/api/v1/contract-signers/${tenant}/${id}` + path, backend()), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(70_000), ...init
  })
  const bearer = { authorization: `Bearer ${token}` }
  try {
    if (request.method === "GET" && !action.length) {
      if (!token) return entryPage(base, !!verification)
      const data = await json(await successful(await call(session, { headers: bearer })))
      if (!knownFiles(data.documents)) throw new Error("invalid_document_list")
      return documentsPage(base, data.documents)
    }
    if (request.method === "POST" && op === "entrar" && action.length === 1) {
      if (!verification) return entryPage(base, false, undefined, 403)
      if (request.body) await bounded(request, 1024)
      const result = await json(await successful(await call(session, { method: "POST", headers: { "x-contract-portal-verification": "email_2fa_slug=" + verification } })))
      if (typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token)) throw new Error("invalid_session")
      return new Response(null, { status: 303, headers: { ...responseHeaders, location: base,
        "set-cookie": `${sessionName}=${result.token}; Path=${base}; Max-Age=900; HttpOnly; Secure; SameSite=Strict` } })
    }
    if (action.length !== 2 || !doc || !idPattern.test(doc) || !((op === "baixar" && request.method === "GET") || (op === "enviar" && request.method === "POST"))) return absent()
    if (!token) return entryPage(base, !!verification, "Confirme o acesso para continuar.", 403)
    if (op === "baixar") {
      const response = await successful(await call(document, { headers: bearer }))
      if (response.headers.get("content-type")?.split(";")[0] !== "application/pdf") throw new Error("invalid_content")
      const bytes = await bounded(response, maxFile)
      const tag = response.headers.get("etag")
      const expectedHash = /^"[1-9]\d{0,18}:[1-9]\d{0,18}:([a-f0-9]{64})"$/.exec(tag || "")?.[1]
      if (!pdf(bytes) || createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new Error("invalid_pdf")
      return new Response(bytes, { headers: { ...responseHeaders, "content-type": "application/pdf", "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="contrato-${doc}.pdf"` } })
    }
    const type = request.headers.get("content-type") || ""
    if (!/^multipart\/form-data;\s*boundary=[\w'()+,./:=?"-]{1,75}$/i.test(type)) throw new BoundaryError(422, "Selecione o PDF assinado.")
    const body = await bounded(request, maxFile + 16 * 1024)
    let form: FormData
    try { form = await new Response(body, { headers: { "content-type": type } }).formData() }
    catch { throw new BoundaryError(422, "Não foi possível ler o arquivo enviado.") }
    const file = form.get("file"), revision = form.get("revision")
    if (Array.from(form.keys()).length !== 2 || typeof revision !== "string" || !revisionPattern.test(revision) || !(file instanceof Blob))
      throw new BoundaryError(422, "Confira o arquivo e reabra a versão atual do documento.")
    if (file.size > maxFile) throw new BoundaryError(413, apiProblem(413))
    if (!pdf(new Uint8Array(await file.slice(0, 5).arrayBuffer()))) throw new BoundaryError(422, "Selecione um arquivo PDF assinado.")
    const result = await json(await successful(await call(document, { method: "POST",
      headers: { ...bearer, "content-type": "application/pdf", "if-match": `"${revision}"` }, body: file })))
    if (!["personal_signing", "completed"].includes(result.phase) || !/^[1-9]\d{0,18}$/.test(String(result.revision))) throw new Error("invalid_receipt")
    return messagePage(base, "Assinatura validada", result.phase === "completed" ? "Todos os participantes concluíram as assinaturas deste contrato." :
      "O PDF assinado foi aceito. Consulte a lista para verificar se há outro documento na sua etapa.", 200)
  } catch (error) {
    const status = error instanceof BoundaryError ? error.status : 503
    const message = error instanceof BoundaryError ? error.message : apiProblem(status)
    if (status === 401 || status === 403) {
      const response = entryPage(base, !!verification, message, status)
      response.headers.set("set-cookie", `${sessionName}=; Path=${base}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`)
      return response
    }
    return messagePage(base, "Assinatura com e-CPF", message, status)
  }
}
