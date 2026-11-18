import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { sha256 } from "./danfe.js"
import { smtpConfigured, type Outcome } from "./smtp.js"

export type DocumentKind = "nfe" | "received-nfses" | "outgoing-nfses"
type DocumentRow = {
  status: string; model: number; revision: string; number: string; series: number; environment: string;
  access_key: string; company_tax_id: string; xml: string; recipient_email: string | null; recipient_name: string | null; recipient_tax_id: string | null; own_document: boolean
}
export type Delivery = {
  id: string; document_kind: DocumentKind; document_id: string; recipient: string; status: Outcome; sent_at: Date | null; confirmed_etag: string
}
const deliveryFields = "id,document_kind,document_id,recipient,status,sent_at,confirmed_etag"

export async function commandDelivery(context: AuthorizedContext, key: string) {
  return (await context.client.query<Delivery>(
    `SELECT ${deliveryFields} FROM fiscal_nfe_email_deliveries WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3`,
    [context.tenantId, context.authSubject, key],
  )).rows[0]
}

export async function readDocument(context: AuthorizedContext, id: string) {
  // The identity in the authorized XML determines which registration can supply an address.
  const row = (await context.client.query<DocumentRow>(`
    SELECT doc.status,doc.model,doc.revision,doc.number,doc.series,doc.environment,doc.access_key,t.tax_id AS company_tax_id,
      coalesce(x.recipient,x.foreign_id) AS recipient_tax_id,
      doc.authorized_xml AS xml, (x.issuer=t.tax_id AND x.xml_id=('NFe'||doc.access_key)
        AND x.model=doc.model::text AND x.protocol_key=doc.access_key AND x.status IN ('100','150')) AS own_document,
      CASE WHEN x.recipient=t.tax_id THEN t.legal_name ELSE coalesce(p.legal_name,
        CASE WHEN x.recipient=d.details->'recipient'->>'taxId' OR x.foreign_id=d.details->'recipient'->>'foreignId'
          THEN nullif(trim(d.details#>>'{recipient,legalName}'),'') END, x.recipient_name) END AS recipient_name,
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
      '/n:nfeProc/n:NFe/n:infNFe' PASSING XMLPARSE(DOCUMENT CASE WHEN doc.model IN (55,65) AND doc.status='authorized' THEN doc.authorized_xml END)
      COLUMNS xml_id text PATH '@Id', model text PATH 'n:ide/n:mod', protocol_key text PATH '../../n:protNFe/n:infProt/n:chNFe',
        status text PATH '../../n:protNFe/n:infProt/n:cStat', issuer text PATH 'n:emit/n:CNPJ', recipient text PATH 'n:dest/n:CNPJ | n:dest/n:CPF',
        foreign_id text PATH 'n:dest/n:idEstrangeiro', email text PATH 'n:dest/n:email', recipient_name text PATH 'n:dest/n:xNome') x ON true
    LEFT JOIN parties p ON p.tenant_id=doc.tenant_id AND p.tax_id=x.recipient
    WHERE doc.tenant_id=$1 AND doc.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "NF-e não encontrada")
  if (row.status !== "authorized" || ![55,65].includes(row.model) || !row.xml || !row.own_document || !/^\d{44}$/.test(row.access_key)) {
    throw new Problem(409, "nfe_not_authorized", "O envio requer uma NF-e ou NFC-e autorizada e emitida pela empresa ativa")
  }
  const recipient = z.email().max(254).safeParse(row.recipient_email?.trim())
  return { ...row, recipientEmail: recipient.success ? recipient.data : null, provider_name: null }
}

async function readServiceInvoice(context: AuthorizedContext, id: string, kind: Exclude<DocumentKind, "nfe">) {
  const query = kind === "received-nfses" ? `
    SELECT t.tax_id AS company_tax_id,doc.environment,doc.access_key,doc.xml,doc.xml_sha256,doc.metadata->>'number' AS number,
      '1' AS revision, t.legal_name AS recipient_name, doc.metadata#>>'{provider,name}' AS provider_name,
      coalesce(nullif(trim(c.details->>'email'),''), x.email) AS recipient_email
    FROM fiscal_received_nfses doc JOIN tenants t ON t.id=doc.tenant_id AND t.tax_id=doc.company_tax_id
    LEFT JOIN company_profiles c ON c.tenant_id=t.id
    LEFT JOIN XMLTABLE(XMLNAMESPACES('http://www.sped.fazenda.gov.br/nfse' AS n),
      '/n:NFSe/n:infNFSe/n:DPS/n:infDPS/n:toma' PASSING XMLPARSE(DOCUMENT doc.xml)
      COLUMNS tax_id text PATH 'n:CNPJ',email text PATH 'n:email') x ON x.tax_id=t.tax_id
    WHERE doc.tenant_id=$1 AND doc.id=$2` : `
    SELECT t.tax_id AS company_tax_id,doc.environment,doc.access_key,doc.xml,doc.xml_sha256,coalesce(doc.nfse_number,x.number) AS number,doc.revision,
      coalesce(p.legal_name,nullif(trim(doc.request_snapshot#>>'{customer,name}'),''),x.recipient_name) AS recipient_name,
      NULL::text AS provider_name,
      CASE WHEN p.id IS NOT NULL THEN CASE WHEN p.status='active' THEN p.email END
           ELSE coalesce(x.email, doc.request_snapshot#>>'{customer,email}') END AS recipient_email
    FROM fiscal_outgoing_nfse_issuances doc JOIN tenants t ON t.id=doc.tenant_id
    JOIN XMLTABLE(XMLNAMESPACES('http://www.sped.fazenda.gov.br/nfse' AS n),
      '/n:NFSe/n:infNFSe' PASSING XMLPARSE(DOCUMENT doc.xml) COLUMNS xml_id text PATH '@Id',number text PATH 'n:nNFSe',
      provider text PATH 'n:DPS/n:infDPS/n:prest/n:CNPJ | n:DPS/n:infDPS/n:prest/n:CPF',
      recipient text PATH 'n:DPS/n:infDPS/n:toma/n:CNPJ | n:DPS/n:infDPS/n:toma/n:CPF',
      recipient_name text PATH 'n:DPS/n:infDPS/n:toma/n:xNome',
      email text PATH 'n:DPS/n:infDPS/n:toma/n:email') x ON x.provider=t.tax_id AND x.xml_id='NFS'||doc.access_key
      AND x.recipient=doc.request_snapshot#>>'{customer,taxId}'
    LEFT JOIN parties p ON p.tenant_id=t.id AND p.tax_id=x.recipient
    WHERE doc.tenant_id=$1 AND doc.id=$2 AND doc.status='authorized'`
  const row = (await context.client.query<{
    company_tax_id: string; environment: string; access_key: string; xml: string; xml_sha256: string; number: string; revision: string;
    recipient_email: string | null; recipient_name: string | null; provider_name: string | null
  }>(query, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "NFS-e com XML disponível não encontrada nesta empresa")
  if (!row.xml || sha256(row.xml) !== row.xml_sha256 || !/^\d{50}$/.test(row.access_key) || !row.number) {
    throw new Problem(409, "document_unavailable", "O XML original da NFS-e está indisponível")
  }
  const accepted = z.email().max(254).safeParse(row.recipient_email?.trim())
  return { ...row, model: 0, series: 0, recipientEmail: accepted.success ? accepted.data : null }
}

export async function preview(context: AuthorizedContext, id: string, kind: DocumentKind = "nfe") {
  const doc = kind === "nfe" ? await readDocument(context, id) : await readServiceInvoice(context, id, kind)
  const delivery = (await context.client.query<Delivery>(
    `SELECT ${deliveryFields} FROM fiscal_nfe_email_deliveries WHERE tenant_id=$1 AND document_id=$2 AND document_kind=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [context.tenantId, id, kind],
  )).rows[0]
  const status = delivery?.status === "unknown" || delivery?.recipient === doc.recipientEmail ? delivery.status : "ready"
  const result = {
    tenantId: context.tenantId, recipientEmail: doc.recipientEmail, status,
    documentLabel: kind !== "nfe" ? "NFS-e" : doc.model === 65 ? "NFC-e" : "NF-e",
    attachments: doc.model === 55 ? ["DANFE em PDF", "XML autorizado da NF-e"] : [kind === "received-nfses" ? "XML original importado da NFS-e" : doc.model === 65 ? "XML autorizado da NFC-e" : "XML autorizado da NFS-e"],
    smtpConfigured: await smtpConfigured(context.client), sentAt: status === "sent" ? delivery?.sent_at : null,
  }
  const xmlHash = sha256(doc.xml)
  const etag = `"${sha256(JSON.stringify([id, doc.revision, xmlHash, delivery?.id, result]))}"`
  return { doc, result, etag, xmlHash }
}
