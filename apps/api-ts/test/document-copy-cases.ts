import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Pool } from "pg"
import { buildApp } from "../src/app.js"
import type { DatabasePool } from "../src/platform/database.js"
import type { DocumentMail } from "../src/platform/document-mail.js"
import { digest } from "../src/modules/document-copies/source.js"

const signers = [
  { role: "Cliente", name: "Alice", email: "alice@example.test" },
  { role: "Testemunha", name: "Bob", email: "bob@example.test" },
]

// The mailer consumes verdicts persisted by the private validator. Fixtures below
// model those database records and identify the exact final bytes the mailer uses.
async function signatureFixture(seed: Pool, tenant: string, contract: string, base: Buffer) {
  const envelope = randomUUID(), document = randomUUID(), preflight = randomUUID()
  const policyHash = digest("test signing policy"), trustHash = digest("test trust bundle")
  const bundle = Buffer.from("synthetic validation evidence"), bundleHash = digest(bundle), baseHash = digest(base)
  await seed.query(`INSERT INTO contract_signature_envelopes
    (tenant_id,id,contract_id,policy,policy_sha256,trust_bundle_sha256,participant_count)
    VALUES($1,$2,$3,'icp_each_participant',$4,$5,$6)`, [tenant, envelope, contract, policyHash, trustHash, signers.length])
  await seed.query(`INSERT INTO contract_signature_documents(tenant_id,envelope_id,id,position,provider_document_id,sha256,content)
    VALUES($1,$2,$3,1,'provider-document',$4,$5)`, [tenant, envelope, document, baseHash, base])
  // Even a completed state cannot substitute for a missing personal signature.
  await seed.query(`INSERT INTO contract_signature_states(tenant_id,envelope_id,phase,current_participant,document_count,documents_frozen_at,completed_at)
    VALUES($1,$2,'completed',$3,1,now(),now())`, [tenant, envelope, signers.length])
  const participants: string[] = []
  for (const [i, signer] of signers.entries()) {
    const id = randomUUID()
    await seed.query(`INSERT INTO contract_signature_participants
      (tenant_id,envelope_id,id,position,role,name,email,cpf_masked,identity_key_id,identity_nonce,identity_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6,$7,'***.***.***-00','test',$8,$9)`,
    [tenant, envelope, id, i + 1, signer.role, signer.name, signer.email, Buffer.alloc(12), Buffer.alloc(27)])
    participants.push(id)
  }
  async function evidence(id: string, participant: string | null, parentHash: string, candidateHash: string) {
    await seed.query(`INSERT INTO contract_signature_evidence(tenant_id,envelope_id,id,document_id,participant_id,mode,verdict,
      parent_sha256,candidate_sha256,policy_sha256,trust_bundle_sha256,evidence_set_sha256,report_sha256,bundle_sha256,response_headers,bundle,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,'accepted',$7,$8,$9,$10,$11,$11,$11,'{}',$12,now())`,
    [tenant, envelope, id, document, participant, participant ? "increment" : "preflight", parentHash, candidateHash, policyHash, trustHash, bundleHash, bundle])
  }
  await evidence(preflight, null, baseHash, baseHash)
  await seed.query(`INSERT INTO contract_signature_heads(tenant_id,envelope_id,document_id,base_sha256,sha256,preflight_evidence_id)
    VALUES($1,$2,$3,$4,$4,$5)`, [tenant, envelope, document, baseHash, preflight])
  let head = base, sequence = 0
  return async function addSignature() {
    const participant = participants[sequence]!, previousSequence = sequence || null
    const revision = randomUUID(), verdict = randomUUID(), parentHash = digest(head)
    sequence++
    head = Buffer.concat([head, Buffer.from("\nsynthetic increment " + sequence)])
    const candidateHash = digest(head)
    await evidence(verdict, participant, parentHash, candidateHash)
    await seed.query(`INSERT INTO contract_signature_revisions(tenant_id,envelope_id,document_id,id,sequence,participant_id,
      base_sha256,parent_sequence,parent_sha256,sha256,content,evidence_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tenant, envelope, document, revision, sequence, participant, baseHash, previousSequence, parentHash, candidateHash, head, verdict])
    await seed.query(`UPDATE contract_signature_heads SET sequence=$4,revision_id=$5,sha256=$6,revision=revision+1
      WHERE tenant_id=$1 AND envelope_id=$2 AND document_id=$3`, [tenant, envelope, document, sequence, revision, candidateHash])
    return head
  }
}

export async function verifyDocumentCopies(seed: Pool, pool: DatabasePool, other: string) {
  const tenant = randomUUID(), role = randomUUID(), membership = randomUUID(), order = randomUUID()
  await seed.query("INSERT INTO tenants(id,legal_name,trade_name,tax_id) VALUES($1,'Empresa de documentos','Marca de teste','19131243000197')", [tenant])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject='reader'", [membership, tenant])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'documents','Documentos')", [role, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')", [tenant])
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2026-12-18',12345,'draft')", [order, tenant])
  const supplier = randomUUID(), purchase = randomUUID(), receipt = randomUUID(), payable = randomUUID(), contract = randomUUID()
  const pdf = Buffer.from("%PDF-1.7\npreserved signed bytes")
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Fornecedor','11144477735','supplier@example.test',false,true,'active')", [supplier, tenant])
  await seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor','11144477735','2026-12-18',12345,'received')", [purchase, tenant, supplier])
  await seed.query("INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Teste','2026-11-17',12345)", [receipt, tenant, purchase])
  await seed.query("INSERT INTO payables(id,tenant_id,receipt_id,supplier_name,due_date,amount_cents) VALUES($1,$2,$3,'Fornecedor','2026-12-18',12345)", [payable, tenant, receipt])
  await seed.query(`INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status,signature_policy)
    VALUES($1,$2,$2,$3,1,'Contrato teste','{}',$6,$4,'{}',$5,'completed','icp_each_participant')`, [contract, tenant, order, JSON.stringify(signers), digest(contract),
      { order: { id: order, number: "42", amount: "123.45", revision: 1 }, customer: { name: "Cliente", taxId: "52998224725" }, company: { legalName: "Empresa", tradeName: "Marca do contrato", taxId: "19131243000197" }, items: [] }])
  for (const kind of ["signed", "preview", "audit"])
    await seed.query("INSERT INTO commercial_contract_files(id,tenant_id,contract_id,kind,position,sha256,content) VALUES($1,$2,$3,$4,0,$5,$6)", [randomUUID(), tenant, contract, kind, digest(pdf), pdf])
  const permissions = ["finance.receivables.read", "finance.receivables.manage", "finance.payables.read", "finance.payables.manage", "sales.orders.read", "sales.orders.manage", "sales.contracts.send", "sales.contracts.package"]
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING", [role, permissions])
  const mails: DocumentMail[] = []
  let outcome: "failed" | "sent" = "sent"
  const app = buildApp({
    pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "reader", email: "reader@example.test" }),
    documentCopies: { configured: () => true, send: async mail => { mails.push(mail); return outcome } },
    nfeEmail: { render: async () => Buffer.from("%PDF-DANFE"), sender: async () => async () => "sent" },
  })
  const headers = { authorization: "Bearer reader", "x-tenant-id": tenant }
  const customSubject = "  Demonstrativo para conferência  "
  const customMessage = "  Olá!\n\nConfira o campo <valor> no anexo.  "
  function checkMail(mail: DocumentMail, company: string) {
    assert.equal(mail.subject, customSubject)
    assert.ok(mail.text.includes(customMessage))
    assert.ok(mail.text.includes(company))
    assert.ok(mail.html)
    assert.ok(mail.html.includes(company))
    assert.ok(mail.html.includes("&lt;valor&gt;"))
    for (const { filename } of mail.attachments) {
      assert.ok(mail.text.includes(filename))
      assert.ok(mail.html.includes(filename))
    }
  }
  try {
    for (const [resource, id, expected] of [["financial-payables", payable, "supplier@example.test"], ["commercial-contracts", contract, "alice@example.test, bob@example.test"]] as const) {
      const url = `/api/v1/${resource}/${id}/email`, key = randomUUID()
      assert.equal((await app.inject({ method: "GET", url, headers: { ...headers, "x-tenant-id": other } })).statusCode, 403)
      const get = await app.inject({ method: "GET", url, headers })
      assert.equal(get.statusCode, 200, get.body)
      const preview = get.json()
      assert.equal(preview.recipient, expected); assert.equal(preview.canSend, true); assert.equal(preview.recordCount, 1)
      assert.ok(preview.suggestedSubject.includes(resource === "financial-payables" ? "Marca de teste" : "Marca do contrato"))
      assert.match(preview.suggestedMessage, resource === "financial-payables" ? /Olá, Fornecedor!/ : /cópia assinada do contrato/)
      const post = (recipient: string) => app.inject({
        method: "POST", url, headers: { ...headers, "if-match": String(get.headers.etag), "idempotency-key": key },
        payload: { recipient, subject: customSubject, message: customMessage, snapshotHash: preview.snapshotHash }
      })
      assert.equal((await post("other@example.test")).statusCode, 412)
      const [first, second] = await Promise.all([post(expected), post(expected)])
      for (const result of [first, second]) assert.ok([200, 202].includes(result.statusCode), result.body)
      assert.equal((await post(expected)).json().delivery.status, "sent")
      const history = (await app.inject({ method: "GET", url, headers })).json()
      assert.equal(history.deliveries.length, 1)
      checkMail(mails.at(-1)!, resource === "financial-payables" ? "Marca de teste" : "Marca do contrato")
    }
    assert.equal(mails.length, 2)
    assert.equal(mails[0]!.attachments[0]!.content.subarray(0, 5).toString(), "%PDF-")
    assert.deepEqual(mails[1]!.to, ["alice@example.test", "bob@example.test"])
    assert.equal(mails[1]!.attachments.length, 1)
    assert.deepEqual(mails[1]!.attachments[0]!.content, pdf)
    const title = randomUUID()
    await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','2026-12-18',12345,'open')", [title, tenant, order])
    for (const url of [`/api/v1/receivables/${title}/email`, "/api/v1/financial-report/email"]) {
      const preview = await app.inject({ method: "GET", url, headers })
      assert.equal(preview.statusCode, 200, preview.body)
      assert.match(preview.json().snapshotHash, /^[0-9a-f]{64}$/)
      const isReport = url.includes("financial-report")
      assert.equal(preview.json().recordCount, isReport ? 2 : 1)
      assert.match(preview.json().suggestedSubject, /Marca de teste/)
      assert.match(preview.json().suggestedMessage, isReport ? /contas a receber e a pagar/ : /recebimentos que registramos/)
      const key = randomUUID(), payload = { recipient: "financial@example.test", subject: customSubject, message: customMessage, snapshotHash: preview.json().snapshotHash }
      const post = (hash: string) => app.inject({ method: "POST", url, headers: { ...headers, "if-match": String(preview.headers.etag), "idempotency-key": key }, payload: { ...payload, snapshotHash: hash } })
      assert.equal((await post("a".repeat(64))).statusCode, 412)
      const sent = await post(payload.snapshotHash)
      assert.equal(sent.statusCode, 200, sent.body); assert.equal(sent.json().delivery.status, "sent")
      assert.equal((await post(payload.snapshotHash)).json().delivery.id, sent.json().delivery.id)
      checkMail(mails.at(-1)!, "Marca de teste")
      if (isReport) assert.doesNotMatch(mails.at(-1)!.text, /Cliente|Fornecedor/)
      const stored = (await seed.query("SELECT pdf_content,pdf_sha256,snapshot,filename,subject,message FROM finance_document_email_deliveries WHERE id=$1", [sent.json().delivery.id])).rows[0]
      assert.equal(stored.subject, customSubject)
      assert.equal(stored.message, customMessage)
      assert.equal(stored.snapshot.company.legalName, "Empresa de documentos")
      assert.equal("tradeName" in stored.snapshot.company, false)
      assert.equal(stored.pdf_sha256, digest(stored.pdf_content))
      if (isReport) {
        assert.equal(stored.snapshot.rows.length, 2)
        assert.equal(stored.snapshot.totals.receivable, "123.45")
        assert.equal(stored.snapshot.totals.payable, "123.45")
      } else {
        assert.equal(stored.snapshot.receivables[0].amountCents, 12345)
        assert.equal(stored.snapshot.payables.length, 0)
      }
      assert.equal(stored.filename, mails.at(-1)!.attachments[0]!.filename)
      assert.deepEqual(stored.pdf_content, mails.at(-1)!.attachments[0]!.content)
    }
    assert.equal(mails.length, 4)
    const packageUrl = `/api/v1/commercial-contracts/${contract}/send-package`
    const emails = signers.map(signer => signer.email)
    const getPackage = async () => {
      const response = await app.inject({ method: "GET", url: packageUrl, headers })
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.headers.etag, '"1"')
      assert.equal(response.headers["cache-control"], "no-store")
      return response.json<{ checks: { label: string; ready: boolean }[]; closingHash: string; recipients: string[]; packageStatus: string | null; completePackage: boolean }>()
    }
    const postPackage = (key = randomUUID(), recipients = emails, closingHash?: string) => app.inject({
      method: "POST", url: packageUrl, payload: { recipients, closingHash }, headers: { ...headers, "idempotency-key": key, "if-match": '"1"' },
    })
    assert.equal((await app.inject({ method: "GET", url: packageUrl, headers: { ...headers, "x-tenant-id": other } })).statusCode, 403)
    const initial = await getPackage()
    assert.deepEqual(initial.recipients, emails)
    assert.match(initial.closingHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(Object.fromEntries(initial.checks.map(c => [c.label, c.ready])),
      { "Contrato": false, "Pedido": true, "NF-e": false, "Orçamento": false, "Comprovante de pagamento": false })
    assert.equal(initial.packageStatus, null)
    assert.equal((await postPackage(randomUUID(), ["different@example.test"])).statusCode, 412)
    const denied = await postPackage(randomUUID(), emails, initial.closingHash)
    assert.equal(denied.statusCode, 409, denied.body)
    assert.match(denied.json().type, /signature_unverified$/)
    assert.match((await postPackage()).json().type, /signature_unverified$/)
    const addSignature = await signatureFixture(seed, tenant, contract, pdf)
    await addSignature()
    assert.equal((await getPackage()).checks.find(c => c.label === "Contrato")?.ready, false)
    assert.match((await postPackage()).json().type, /signature_unverified$/)
    assert.equal(mails.length, 4)
    assert.equal((await seed.query("SELECT 1 FROM commercial_contract_deliveries WHERE tenant_id=$1 AND contract_id=$2", [tenant, contract])).rowCount, 0)
    const finalContract = await addSignature()
    assert.equal((await getPackage()).checks.find(c => c.label === "Contrato")?.ready, true)
    assert.match((await postPackage()).json().type, /nfe_unavailable$/)
    const invoice = randomUUID()
    const xml = (await readFile(new URL("../../api/tests/fixtures/nfe-protocol-synthetic.xml", import.meta.url), "utf8"))
      .replace("<CNPJ>19131243000197</CNPJ>", "<CPF>52998224725</CPF>").replaceAll("04252011000110", "19131243000197")
    const accessKey = xml.match(/Id="NFe(\d{44})"/)![1]!
    await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'homologation',55,1,1,'{}','{}',1)", [tenant, invoice])
    await seed.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol)
      VALUES($1,$2,$3,'authorized',1,1,'2026-11-17','00000001',$4,'signed-only',$5,'135260000000000')`, [tenant, invoice, order, accessKey, xml])
    const incomplete = await getPackage()
    assert.match((await postPackage(randomUUID(), emails, incomplete.closingHash)).json().type, /proposal_unavailable$/)
    outcome = "failed"
    const declined = await postPackage()
    assert.equal(declined.statusCode, 200, declined.body)
    assert.equal(declined.json().packageStatus, "failed")
    assert.equal(mails.at(-1)!.attachments.some(f => f.filename.startsWith("comprovante-")), false)
    assert.doesNotMatch(mails.at(-1)!.text, /comprovante de recebimento/i)
    outcome = "sent"
    const payment = randomUUID()
    await seed.query(`INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on)
      VALUES($1,$2,$3,'receipt',12345,'bank_transfer','Teste','2026-11-17')`, [payment, tenant, title])
    await seed.query("UPDATE receivables SET status='paid',payment_id=$3 WHERE tenant_id=$1 AND id=$2", [tenant, title, payment])
    const key = randomUUID()
    const simultaneous = await Promise.all([postPackage(key), postPackage(key)])
    for (const response of simultaneous) assert.ok([200,202].includes(response.statusCode),response.body)
    assert.equal((await postPackage(key)).json().packageStatus, "sent")
    assert.equal((await postPackage()).json().packageStatus, "sent")
    assert.equal(mails.length, 6)
    const partial = await getPackage()
    assert.equal(partial.completePackage, false)
    assert.equal(partial.checks.find(c => c.label === "Comprovante de pagamento")?.ready, true)
    assert.equal(partial.checks.find(c => c.label === "Orçamento")?.ready, false)
    const proposal = randomUUID()
    await seed.query(`WITH proposal AS (
      INSERT INTO sales_proposals(id,tenant_id,order_id) VALUES($1,$2,$3) RETURNING id,tenant_id
    ) INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,
      delivery_terms,amount_cents,status,created_by,sent_at,decided_at,decided_by)
      SELECT tenant_id,id,1,tenant_id,'Cliente','52998224725','2026-12-18','À vista','Retirada',12345,'accepted','reader',now(),now(),'reader' FROM proposal`,
    [proposal, tenant, order])
    const complete = await getPackage()
    assert.equal(complete.checks.every(c => c.ready), true)
    assert.notEqual(complete.closingHash, partial.closingHash)
    assert.equal((await postPackage(randomUUID(), emails, partial.closingHash)).statusCode, 412)
    const closingKey = randomUUID()
    const upgrades = await Promise.all([postPackage(closingKey, emails, complete.closingHash), postPackage(closingKey, emails, complete.closingHash)])
    for (const response of upgrades) assert.ok([200,202].includes(response.statusCode), response.body)
    assert.equal((await postPackage(closingKey, emails, complete.closingHash)).json().packageStatus, "sent")
    assert.equal((await postPackage(randomUUID(), emails, complete.closingHash)).json().packageStatus, "sent")
    assert.equal((await getPackage()).completePackage, true)
    assert.equal(mails.length, 7)
    const packet = mails.at(-1)!
    assert.deepEqual(packet.to, emails)
    assert.match(packet.subject, /Homologação • sem valor fiscal/)
    assert.ok(packet.text.includes("Homologação • sem valor fiscal"))
    assert.ok(packet.html)
    assert.ok(packet.html.includes("Homologação • sem valor fiscal"))
    assert.match(packet.text, /comprovante de recebimento/)
    assert.doesNotMatch(packet.text, /Olá, Cliente/)
    for (const file of packet.attachments) {
      assert.ok(packet.text.includes(file.filename))
      assert.ok(packet.html.includes(file.filename))
    }
    assert.deepEqual(packet.attachments.map(f => f.contentType), ["application/pdf","application/pdf","application/xml","application/pdf","application/pdf","application/pdf"])
    assert.deepEqual(packet.attachments[2]!.content, Buffer.from(xml))
    assert.deepEqual(packet.attachments[4]!.content, finalContract)
    assert.match(packet.attachments[5]!.filename, /^orcamento-\d+-v1\.pdf$/)
    const manifest = (await seed.query("SELECT attachments,attempts,status FROM commercial_contract_deliveries WHERE tenant_id=$1 AND contract_id=$2",[tenant,contract])).rows[0]
    assert.equal(manifest.status, "sent")
    assert.equal(manifest.attempts, 3)
    assert.deepEqual(manifest.attachments.map((f: {kind: string}) => f.kind), ["order", "danfe", "nfe", "payment", "contract", "proposal"])
    assert.deepEqual(manifest.attachments.map((f: {sha256:string}) => f.sha256),packet.attachments.map(f => digest(f.content)))
    assert.equal(manifest.attachments[3].paymentId,payment)
    assert.equal(manifest.attachments[4].signaturePolicy, "icp_each_participant")
    assert.equal(manifest.attachments[5].proposalId, proposal)
    const saved = await seed.query("SELECT status,revision,send_requested_at FROM commercial_contracts WHERE id=$1", [contract])
    assert.deepEqual(saved.rows[0], { status: "completed", revision: "1", send_requested_at: null })
    const appendix = Buffer.from("%PDF-1.7\nsecond provider document")
    await seed.query(`INSERT INTO commercial_contract_files(id,tenant_id,contract_id,kind,position,sha256,content)
      VALUES($1,$2,$3,'signed',1,$4,$5)`, [randomUUID(), tenant, contract, digest(appendix), appendix])
    await seed.query(`INSERT INTO contract_signature_documents(tenant_id,envelope_id,id,position,provider_document_id,sha256,content)
      SELECT tenant_id,id,$3,2,'provider-appendix',$4,$5 FROM contract_signature_envelopes WHERE tenant_id=$1 AND contract_id=$2`,
    [tenant, contract, randomUUID(), digest(appendix), appendix])
    // A stale document count and a complete first PDF cannot qualify the unsigned appendix.
    assert.equal((await getPackage()).checks.find(c => c.label === "Contrato")?.ready, false)
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='sales.contracts.package'", [role])
    assert.equal((await app.inject({ method: "GET", url: packageUrl, headers })).statusCode, 403)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/commercial-contracts/${contract}/email`, headers })).json().canSend, false)
    const reportUrl = "/api/v1/financial-report/email"
    await seed.query(`WITH orders AS (INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status)
        SELECT gen_random_uuid(),$1,$1,'Cliente selecionado','52998224725','2028-03-01',12345,'completed'
        FROM generate_series(1,105) RETURNING id)
      INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status)
      SELECT gen_random_uuid(),$1,id,'Cliente selecionado','2028-03-01',12345,'open' FROM orders`, [tenant])
    const filters = { side: "receivable", q: "selecionado", from: "2028-03-01", to: "2028-03-01", status: "open", partyId: tenant }
    const query = new URLSearchParams(filters).toString()
    const getPreview = () => app.inject({ method: "GET", url: reportUrl + "?" + query, headers })
    const preview = await getPreview(), exported = await app.inject({ method: "GET", url: "/api/v1/finance/portfolio/export?" + query, headers })
    assert.equal(preview.statusCode, 200, preview.body)
    const result = preview.json(), source = exported.json()
    assert.equal(result.recordCount, 105); assert.deepEqual(result.summary.totals, source.totals)
    assert.equal(result.summary.companyName, "Empresa de documentos"); assert.equal(result.summary.asOf, source.asOf)
    assert.equal(result.summary.totals.receivable, "12962.25"); assert.equal(result.summary.totals.payable, "0.00")
    assert.equal((await app.inject({ method: "GET", url: reportUrl + "?limit=30", headers })).statusCode, 422)
    assert.equal((await app.inject({ method: "GET", url: reportUrl, headers: { ...headers, "x-tenant-id": other } })).statusCode, 403)
    const sendKey = randomUUID()
    const sendReport = (scope: object, snapshotHash: string) => app.inject({
      method: "POST", url: reportUrl, headers: { ...headers, "if-match": String(preview.headers.etag), "idempotency-key": sendKey },
      payload: { filters: scope, snapshotHash, recipient: "financial@example.test", subject: "Carteira filtrada", message: "Confira." }
    })
    // Same rows with a different filter still require review of the scope.
    assert.equal((await sendReport({ ...filters, q: "cliente selecionado" }, result.snapshotHash)).statusCode, 412)
    await seed.query("UPDATE receivables SET amount_cents=10000,revision=revision+1 WHERE id=$1", [source.rows[104].id])
    assert.equal((await sendReport(filters, result.snapshotHash)).statusCode, 412)
    const fresh = (await getPreview()).json()
    const sent = await sendReport(filters, fresh.snapshotHash)
    assert.equal(sent.statusCode, 200, sent.body)
    assert.equal((await sendReport(filters, fresh.snapshotHash)).json().delivery.id, sent.json().delivery.id)
    assert.equal((await sendReport({ ...filters, status: "paid" }, fresh.snapshotHash)).statusCode, 409)
    const evidence = (await seed.query("SELECT snapshot,snapshot_hash,pdf_content FROM finance_document_email_deliveries WHERE id=$1", [sent.json().delivery.id])).rows[0]
    assert.deepEqual(evidence.snapshot.filters, filters)
    assert.equal(evidence.snapshot.total, 105)
    assert.equal(evidence.snapshot_hash, fresh.snapshotHash)
    assert.equal(evidence.snapshot.totals.receivable, "12938.80")
    assert.deepEqual(evidence.snapshot.rows.map((r: { id: string }) => r.id), source.rows.map((r: { id: string }) => r.id))
    assert.deepEqual(evidence.pdf_content, mails.at(-1)!.attachments[0]!.content)
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.payables.manage'", [role])
    assert.equal((await getPreview()).json().canSend, false)
    assert.equal((await sendReport(filters, fresh.snapshotHash)).statusCode, 403)
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.payables.read'", [role])
    assert.equal((await getPreview()).statusCode, 403)
  } finally {
    await app.close()
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=ANY($2::text[])", [role, permissions])
  }
}
