import type { AuthorizedContext } from "../../platform/access.js"
import { documentMailLimit, type DocumentMail } from "../../platform/document-mail.js"
import { renderDocumentEmail } from "../../platform/document-mail-template.js"
import { Problem } from "../../platform/problem.js"
import { readDocument } from "../nfe-email/document.js"
import { renderDanfe } from "../nfe-email/danfe.js"
import { acceptedProposalPdf, preservedOrderPdf } from "../sales/mail-document.js"
import { loadProposal } from "../proposals/snapshot.js"
import { brl, financialPdf } from "./financial-pdf.js"
import { copySource, digest } from "./source.js"
import { qualifiedContract } from "./qualified-contract.js"

type Snapshot = {
  company: { legalName: string; tradeName?: string; taxId?: string }; customer: { name: string; taxId?: string }
  order: { number: string; amount: string; revision: number }
  proposal?: { id: string; version: number } | null
}
type Payment = { id: string; amount: string; method: string; reference: string; date: string; count: number }
type Attachment = DocumentMail["attachments"][number]
export async function packageSource(context: AuthorizedContext, id: string) {
  const source = await copySource(context, "contract", id)
  const qualified = await qualifiedContract(context, id)
  const row = (await context.client.query<{ snapshot: Snapshot; order_id: string; nfe_id: string | null; proposal_id: string | null; version: number | null }>(`
    SELECT c.snapshot,c.order_id,p.id AS proposal_id,v.version,(SELECT d.id FROM fiscal_nfe_documents d
      WHERE d.tenant_id=c.tenant_id AND d.source_order_id=c.order_id AND d.model=55 AND d.status='authorized' AND d.authorized_xml IS NOT NULL
      ORDER BY (d.environment='production') DESC,d.updated_at DESC,d.id LIMIT 1) AS nfe_id
    FROM commercial_contracts c
    LEFT JOIN sales_proposals p ON p.tenant_id=c.tenant_id AND p.order_id=c.order_id
    LEFT JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id AND v.version=p.current_version
      AND v.status='accepted' AND v.customer_id=c.customer_id
    WHERE c.tenant_id=$1 AND c.id=$2`, [context.tenantId, id])).rows[0]!
  const invoice = row.nfe_id ? await readDocument(context, row.nfe_id) : null
  const { snapshot } = row
  const validOrder = /^\d+(?:\.\d{2})?$/.test(snapshot.order?.amount) && !!snapshot.order?.number && !!snapshot.company?.legalName && !!snapshot.customer?.name
  const [whole, cents = "00"] = (validOrder ? snapshot.order.amount : "0").split(".")
  const pinned = snapshot.proposal
  const proposal = row.proposal_id && row.version && (!pinned || (pinned.id === row.proposal_id && pinned.version === row.version))
    ? await loadProposal(context, row.proposal_id, row.version) : null
  const amount = BigInt(whole! + cents)
  const payments = (await context.client.query<Payment>(`
    WITH titles AS (
      SELECT r.id,r.status,r.amount_cents,coalesce((SELECT sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END)
        FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id),0) AS received
      FROM receivables r WHERE r.tenant_id=$1 AND r.order_id=$2
    ), settled AS (
      SELECT count(*)::int AS count FROM titles HAVING count(*)>0 AND bool_and(status='paid' AND amount_cents=received) AND sum(amount_cents)=$3::numeric
    )
    SELECT p.id,p.amount_cents::text AS amount,p.method,p.reference,p.occurred_on::text AS date,settled.count
    FROM settled CROSS JOIN titles t JOIN receivable_payments p ON p.tenant_id=$1 AND p.receivable_id=t.id
    WHERE p.kind='receipt' AND NOT EXISTS(SELECT 1 FROM receivable_payments reversed WHERE reversed.tenant_id=p.tenant_id AND reversed.reverses_id=p.id)
    ORDER BY p.occurred_on,p.id`, [context.tenantId, row.order_id, amount])).rows
  const signature = digest(JSON.stringify([source.hash, qualified?.heads, snapshot, row.nfe_id, invoice && digest(invoice.xml), invoice?.environment,
    proposal && [row.proposal_id, row.version, proposal.items], payments]))
  const checks = [
    { label: "Contrato", ready: !!qualified && source.allowed && !!source.recipients.length, detail: !qualified ? "Falta validar a assinatura ICP-Brasil de cada participante em todos os PDFs finais" : !source.allowed || !source.recipients.length ? "Confira o pedido e os destinatários do contrato" : `${qualified.signers} participante(s) • assinaturas ICP-Brasil verificadas em ${qualified.documents} PDF(s)`, code: "signature_unverified" },
    { label: "Pedido", ready: validOrder, detail: validOrder ? "Pedido " + snapshot.order.number : "Os dados preservados do pedido estão incompletos", code: "invalid_snapshot" },
    { label: "NF-e", ready: !!invoice?.recipient_tax_id && invoice.recipient_tax_id === snapshot.customer?.taxId,
      detail: !invoice ? "O pedido ainda não possui NF-e autorizada" : invoice.recipient_tax_id !== snapshot.customer?.taxId ? "O destinatário da NF-e difere do cliente do contrato" : "DANFE e XML • " + (invoice.environment === "homologation" ? "Homologação • sem valor fiscal" : "Produção"),
      code: invoice ? "nfe_customer_mismatch" : "nfe_unavailable" },
    { label: "Orçamento", ready: !!proposal, detail: proposal ? "Proposta " + proposal.data.number + " • versão " + proposal.data.version : "Falta uma proposta aceita e vinculada a este pedido e cliente", code: "proposal_unavailable" },
    { label: "Comprovante de pagamento", ready: !!payments.length, detail: payments.length ? payments.length + " recibo(s) do ERP • quitação integral" : "Falta registrar a quitação integral dos títulos deste pedido", code: "payment_unavailable" },
  ]
  return { source, qualified, snapshot, invoice, proposal, payments, amount, signature, checks }
}

export function confirmPackage(input: Awaited<ReturnType<typeof packageSource>>, complete: boolean) {
  const missing = input.checks.find(check => !check.ready && (complete || !["proposal_unavailable", "payment_unavailable"].includes(check.code)))
  if (missing) throw new Problem(409, missing.code, missing.detail)
  if (!input.qualified) throw new Problem(409, "signature_unverified", "Falta a comprovação das assinaturas ICP-Brasil")
  if (!input.invoice) throw new Problem(409, "nfe_unavailable", "O pedido ainda não possui NF-e autorizada")
  return { ...input, invoice: input.invoice, qualified: input.qualified }
}

export async function packageFiles(input: ReturnType<typeof confirmPackage>, contracts: Attachment[], render: typeof renderDanfe) {
  const { invoice, proposal, snapshot, payments, amount } = input
  const number = snapshot.order.number
  const filenameNumber = number.replace(/[^A-Za-z0-9_-]/g, "_")
  const notice = invoice.environment === "homologation" ? "Homologação • sem valor fiscal" : ""
  const subject = [`Documentos do pedido ${number}`, notice].filter(Boolean).join(" • ")
  const attachments: Attachment[] = []
  const manifest: Record<string, unknown>[] = []
  let size = 0
  function add(kind: string, file: Attachment, extra: Record<string, unknown> = {}) {
    size += file.content.length
    if (size > documentMailLimit || attachments.length >= 40) throw new Problem(413, "attachment_limit", "O pacote excede o limite de anexos do serviço de e-mail")
    attachments.push(file)
    manifest.push({ kind, filename: file.filename, contentType: file.contentType, sha256: digest(file.content), ...extra })
  }
  const pdf = (filename: string, content: Buffer) => ({ filename, content, contentType: "application/pdf" })
  add("order", pdf(`pedido-${filenameNumber}.pdf`, await preservedOrderPdf(snapshot)))
  const invoiceFile = `nfe-${invoice.number}-serie-${invoice.series}`
  const danfe = await render({ issuerTaxId: invoice.company_tax_id, xml: invoice.xml, accessKey: invoice.access_key, environment: invoice.environment })
  add("danfe", pdf(`danfe-${invoiceFile}.pdf`, danfe), { accessKey: invoice.access_key })
  add("nfe", { filename: invoiceFile + ".xml", contentType: "application/xml", content: Buffer.from(invoice.xml) }, { accessKey: invoice.access_key })
  for (const payment of payments) {
    const receipt = await financialPdf("Comprovante de recebimento", snapshot.company.legalName, doc => {
      const date = payment.date.split("-").reverse().join("/")
      doc.moveDown().font("Helvetica").fontSize(11).text([
        "Emitente • " + (snapshot.company.taxId || snapshot.company.legalName), "Cliente • " + snapshot.customer.name,
        "CPF/CNPJ • " + (snapshot.customer.taxId || "Não informado"), "Pedido • " + number,
        "Valor recebido • " + brl(BigInt(payment.amount)), "Forma de pagamento • " + payment.method,
        "Referência • " + payment.reference, "Data do recebimento • " + date,
      ].join("\n"), { lineGap: 5 })
    })
    add("payment", pdf(`comprovante-pagamento-${payment.id}.pdf`, receipt), { paymentId: payment.id, amountCents: BigInt(payment.amount), settlementTotalCents: amount, titleCount: payment.count })
  }
  for (const file of contracts) add("contract", file, { signaturePolicy:"icp_each_participant", envelopeId:input.qualified.envelope })
  if (proposal) {
    const { id, number, version } = proposal.data
    add("proposal", pdf(`orcamento-${number}-v${version}.pdf`, await acceptedProposalPdf(proposal,snapshot.company)), { proposalId: id, version })
  }
  const receiptMessage = payments.length === 1 ? "Incluímos também o comprovante de recebimento." : payments.length > 1 ? "Incluímos também os comprovantes de recebimento." : ""
  const message = ["Olá!", `Reunimos os documentos do pedido ${number}. Em anexo estão o pedido, o DANFE, o XML autorizado da NF-e e a cópia do contrato.`, proposal && "O orçamento aceito que originou este pedido segue em PDF.", receiptMessage].filter(Boolean).join("\n\n")
  const content = renderDocumentEmail({ company: snapshot.company.tradeName?.trim() || snapshot.company.legalName, title: `Documentos do pedido ${number}`, message,
    details: [{ label: "NF-e", value: `${invoice.number} • série ${invoice.series}` }], notice, attachments })
  return { attachments, manifest, subject, ...content }
}
