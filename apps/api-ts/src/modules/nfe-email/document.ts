import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { sha256 } from "./danfe.js"
import { smtpConfigured, type Outcome } from "./smtp.js"

type DocumentRow = {
  status: string; model: number; revision: string; number: string; series: number; environment: string;
  access_key: string; xml: string; recipient_email: string | null; own_document: boolean
}
export type Delivery = {
  id: string; document_id: string; recipient: string; status: Outcome; sent_at: Date | null; confirmed_etag: string
}
const deliveryFields = "id,document_id,recipient,status,sent_at,confirmed_etag"

export async function commandDelivery(context: AuthorizedContext, key: string) {
  return (await context.client.query<Delivery>(
    `SELECT ${deliveryFields} FROM fiscal_nfe_email_deliveries WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3`,
    [context.tenantId, context.authSubject, key],
  )).rows[0]
}

export async function readDocument(context: AuthorizedContext, id: string) {
  // The identity in the authorized XML determines which registration can supply an address.
  const row = (await context.client.query<DocumentRow>(`
    SELECT doc.status,doc.model,doc.revision,doc.number,doc.series,doc.environment,doc.access_key,
      doc.authorized_xml AS xml, x.issuer=t.tax_id AS own_document,
      CASE WHEN x.recipient=t.tax_id THEN coalesce(nullif(trim(c.details->>'email'),''),x.email)
           WHEN p.id IS NOT NULL THEN CASE WHEN p.status='active' THEN p.email END
           WHEN x.email IS NOT NULL THEN x.email
           WHEN x.recipient=d.details->'recipient'->>'taxId'
             OR x.foreign_id=d.details->'recipient'->>'foreignId' THEN d.details->'recipient'->>'email' END AS recipient_email
    FROM fiscal_nfe_documents doc
    JOIN tenants t ON t.id=doc.tenant_id
    JOIN fiscal_nfe_drafts d ON d.tenant_id=doc.tenant_id AND d.id=doc.id
    LEFT JOIN company_profiles c ON c.tenant_id=doc.tenant_id
    LEFT JOIN XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),
      '/n:nfeProc/n:NFe/n:infNFe' PASSING XMLPARSE(DOCUMENT CASE WHEN doc.model=55 AND doc.status='authorized' THEN doc.authorized_xml END)
      COLUMNS issuer text PATH 'n:emit/n:CNPJ', recipient text PATH 'n:dest/n:CNPJ | n:dest/n:CPF',
        foreign_id text PATH 'n:dest/n:idEstrangeiro', email text PATH 'n:dest/n:email') x ON true
    LEFT JOIN parties p ON p.tenant_id=doc.tenant_id AND p.tax_id=x.recipient
    WHERE doc.tenant_id=$1 AND doc.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "NF-e não encontrada")
  if (row.status !== "authorized" || row.model !== 55 || !row.xml || !row.own_document || !/^\d{44}$/.test(row.access_key)) {
    throw new Problem(409, "nfe_not_authorized", "O envio requer uma NF-e modelo 55 autorizada e emitida pela empresa ativa")
  }
  const recipient = z.email().max(254).safeParse(row.recipient_email?.trim())
  return { ...row, recipientEmail: recipient.success ? recipient.data : null }
}

export async function preview(context: AuthorizedContext, id: string) {
  const doc = await readDocument(context, id)
  const delivery = (await context.client.query<Delivery>(
    `SELECT ${deliveryFields} FROM fiscal_nfe_email_deliveries WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [context.tenantId, id],
  )).rows[0]
  const status = delivery?.status === "unknown" || delivery?.recipient === doc.recipientEmail ? delivery.status : "ready"
  const result = {
    tenantId: context.tenantId, recipientEmail: doc.recipientEmail, status,
    smtpConfigured: await smtpConfigured(context.client), sentAt: status === "sent" ? delivery?.sent_at : null,
  }
  const xmlHash = sha256(doc.xml)
  const etag = `"${sha256(JSON.stringify([id, doc.revision, xmlHash, delivery?.id, result]))}"`
  return { doc, result, etag, xmlHash }
}
