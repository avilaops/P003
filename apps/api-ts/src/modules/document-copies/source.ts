import { createHash } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson } from "../../platform/json.js"
import { documentMailLimit } from "../../platform/document-mail.js"
import { Problem } from "../../platform/problem.js"
import { brl } from "./financial-pdf.js"
import { payablePdf, readPayable } from "./payable.js"

export type Kind = "payable" | "contract"
export type File = { filename: string; contentType: string; content: Buffer; sourceId?: string }
export const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex")
export const subjectWithCompany = (subject: string, company: string) =>
  [subject, company].filter(Boolean).join(" • ").replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 200)
const recipients = (values: (string | null)[]) => values.every(v => z.email().max(254).safeParse(v).success)
  ? [...new Set(values.map(v => v!))] : []
type ContractFile = { id: string; kind: string; position: number; sha256: string; size: number }
type Contract = { revision: string; status: string; order_status: string; template_name: string; company: string | null; recipients: { email: string }[]; files: ContractFile[] }

export async function copySource(context: AuthorizedContext, kind: Kind, id: string) {
  if (kind === "payable") {
    const row = await readPayable(context, id)
    const due = row.due.split("-").reverse().join("/")
    const greeting = row.payee.trim() ? `Olá, ${row.payee.trim()}!` : "Olá!"
    return {
      revision: row.revision, recipients: recipients([row.recipient]), allowed: row.status !== "cancelled",
      title: "Título a pagar", scope: "Um título a pagar • valores e pagamentos declarados no ERP", count: 1,
      company: null, details: [{ label: "Vencimento", value: due }, { label: "Valor do título", value: brl(BigInt(row.amount)) }],
      suggestedSubject: `Demonstrativo do título a pagar • ${due}`,
      suggestedMessage: `${greeting}\n\nSegue o demonstrativo para você conferir o valor do título, os pagamentos registrados e o saldo. Se precisar de ajuda com algum lançamento, fale com nossa equipe financeira.`,
      hash: digest(canonicalJson(row)), files: async (): Promise<File[]> => [
        { filename: `titulo-a-pagar-${id}.pdf`, content: await payablePdf(row), contentType: "application/pdf" },
      ]
    }
  }
  const row = (await context.client.query<Contract>(`
    SELECT c.revision::text,c.status,o.status AS order_status,c.template_name,c.recipients,
      COALESCE(NULLIF(btrim(c.snapshot#>>'{company,tradeName}'),''),c.snapshot#>>'{company,legalName}') AS company,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'kind',f.kind,'position',f.position,'sha256',f.sha256,'size',octet_length(f.content)) ORDER BY f.position)
        FROM commercial_contract_files f WHERE f.tenant_id=c.tenant_id AND f.contract_id=c.id
        AND f.kind=CASE WHEN c.status='completed' THEN 'signed' ELSE 'preview' END),'[]'::jsonb) AS files
    FROM commercial_contracts c JOIN sales_orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id
    WHERE c.tenant_id=$1 AND c.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Contrato não encontrado")
  const signed = row.status === "completed"
  const { company: preservedCompany, ...document } = row
  const version = signed ? "assinada" : "revisada"
  const template = row.template_name.replace(/[\p{Cc}\s]+/gu, " ").trim()
  return {
    revision: row.revision, recipients: recipients(row.recipients.map(r => r.email)), count: row.files.length,
    allowed: row.order_status !== "cancelled" && ["reviewed", "send_requested", "sent", "opened", "completed"].includes(row.status) && row.files.length > 0,
    title: `Cópia do contrato • ${row.template_name}`, scope: signed ? "PDF assinado preservado no ERP" : "PDF revisado preservado no ERP",
    company: preservedCompany?.trim() || null, details: [{ label: "Documento", value: row.template_name }, { label: "Versão", value: signed ? "Assinada" : "Revisada" }],
    suggestedSubject: [`Cópia ${version} do contrato`, template].filter(Boolean).join(" • "),
    suggestedMessage: `Olá!\n\nSegue a cópia ${version} do contrato${template ? ` “${template}”` : ""} para consulta.\n\n${signed ? "Guarde o documento com os seus registros." : "Se tiver alguma dúvida sobre o documento, entre em contato conosco."}`,
    hash: digest(canonicalJson([id, document])),
    files: async (): Promise<File[]> => {
      if (row.files.reduce((total, f) => total + f.size, 0) > documentMailLimit) throw new Problem(413, "attachment_limit", "Os PDFs do contrato excedem o limite de envio por e-mail")
      const contents = await context.client.query<{ id: string; content: Buffer }>(
        "SELECT id,content FROM commercial_contract_files WHERE tenant_id=$1 AND contract_id=$2 AND id=ANY($3::uuid[])",
        [context.tenantId, id, row.files.map(f => f.id)],
      )
      return row.files.map(f => {
        const bytes = contents.rows.find(row => row.id === f.id)?.content
        if (!bytes || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || digest(bytes) !== f.sha256) {
          throw new Problem(409, "document_mismatch", "Não foi possível conferir o PDF preservado do contrato")
        }
        return { filename: `contrato-${signed ? "assinado" : "revisado"}-${id}-${f.position + 1}.pdf`, contentType: "application/pdf", content: bytes, sourceId: f.id }
      })
    },
  }
}
