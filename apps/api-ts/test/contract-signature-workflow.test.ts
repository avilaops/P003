import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import { PgClientAdapter } from "../src/platform/database.js"
import { sealCpf } from "../src/modules/contract-signatures/identities.js"
import { ContractSignatureValidationError, type ContractSignatureValidator, type ValidatorContext, type ValidatorReceipt } from "../src/modules/contract-signatures/validator.js"
import { POLICY_SHA256, sha256 } from "../src/modules/contract-signatures/validator-wire.js"
import { cleanSignatureUploads, preparePersonalSignatures, readSigningDocument, uploadSigningDocument, type WorkflowTransaction } from "../src/modules/contract-signatures/workflow.js"

test("PostgreSQL enforces ordered personal signing for all frozen PDFs, authenticated revisions, CAS and quotas",
  { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const adminUrl = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-","")
  const db = "signature_workflow_" + suffix, role = "signature_tester_" + suffix
  const admin = new Pool({connectionString:adminUrl.toString()})
  await admin.query("CREATE DATABASE " + db)
  adminUrl.pathname = "/" + db
  const seed = new Pool({connectionString:adminUrl.toString()})
  const tenant = randomUUID(), envelopeId = randomUUID(), contract = randomUUID(), order = randomUUID()
  const ring = { active:"local",keys:new Map([["local",randomBytes(32)]]) }
  const trust = sha256("workflow-test-trust")
  const participants = ["52998224725","11144477735","12345678909"].map((cpf,i) => ({
    id:randomUUID(),cpf,position:i+1,role:"Papel " + (i+1),name:"Pessoa " + (i+1),email:"p"+i+"@example.test" }))
  const docs = [randomUUID(),randomUUID()]
  const bases = docs.map((_,i) => Buffer.from("%PDF-1.7\nsynthetic-workflow-" + i))
  const txFor = (tenantId: string): WorkflowTransaction => async action => {
    const pg = await seed.connect()
    try {
      await pg.query("BEGIN")
      await pg.query("SET LOCAL ROLE " + role)
      await pg.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId])
      const result = await action({tenantId,client:new PgClientAdapter(pg)})
      await pg.query("COMMIT")
      return result
    } catch (e) { await pg.query("ROLLBACK"); throw e }
    finally { pg.release() }
  }
  const tx = txFor(tenant)
  // Stand-in for the already authenticated client. Wire interoperability is covered separately.
  function receipt(ctx: ValidatorContext, base: Buffer, parent: Buffer, candidate: Buffer, participantId: string | null): ValidatorReceipt {
    const bundle = Buffer.from("constructed workflow storage proof " + randomUUID())
    return { binding:{...ctx,participantId,baseSha256:sha256(base),parentSha256:sha256(parent),candidateSha256:sha256(candidate)},
      bundle,verdict:"accepted",checkedAt:new Date().toISOString(),bundleSha256:sha256(bundle),policySha256:POLICY_SHA256,
      trustBundleSha256:trust, reportSha256:sha256("test report"),evidenceSetSha256:sha256("test set"),requestSha256:sha256("test request"),responseHeaders:{} }
  }
  const validator: ContractSignatureValidator = { policySha256:POLICY_SHA256,trustBundleSha256:trust,
    preflight:async (c,b) => receipt(c,b,b,b,null), increment:async (c,b,p,file,signer,previous) => {
      assert.ok(signer.participantId === participants[previous.length]!.id && signer.expectedCpf === participants[previous.length]!.cpf)
      assert.ok(previous.every((s,i) => s.participantId === participants[i]!.id && s.expectedCpf === participants[i]!.cpf))
      return receipt(c,b,p,file,signer.participantId)
    },
  }
  try {
    const directory = new URL("../../../migrations/",import.meta.url)
    for (const name of (await readdir(directory)).filter(n => n.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(name,directory),"utf8"))
    await seed.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
    await seed.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO " + role)
    await seed.query("GRANT INSERT ON contract_signature_documents,contract_signature_jobs,contract_signature_evidence,contract_signature_revisions,contract_signature_heads,contract_signature_uploads TO "+role)
    await seed.query("GRANT UPDATE ON commercial_contracts,contract_signature_jobs,contract_signature_states,contract_signature_heads,contract_signature_uploads TO "+role)
    await seed.query("GRANT DELETE ON contract_signature_uploads,contract_signature_jobs TO "+role)
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Teste','04252011000110')",[tenant])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Teste','52998224725',true,false,'active')",[tenant])
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Teste','52998224725','2027-01-01',12345,'draft')",[order,tenant])
    await seed.query(`INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,
      recipients,progress,fields,fingerprint,status,signature_policy,external_id,completed_at)
      VALUES($1,$2,$2,$3,1,'Teste','{}','{}',$4,$5,'{}',$6,'completed','icp_each_participant',123,now())`,
    [contract,tenant,order,JSON.stringify(participants.map(({role,name,email})=>({role,name,email}))),
      JSON.stringify(participants.map(({role,email})=>({role,email,completedAt:new Date().toISOString()}))),sha256(contract)])
    await seed.query(`INSERT INTO contract_signature_envelopes(tenant_id,id,contract_id,policy,policy_sha256,trust_bundle_sha256,participant_count)
      VALUES($1,$2,$3,'icp_each_participant',$4,$5,3)`,[tenant,envelopeId,contract,POLICY_SHA256,trust])
    for (const p of participants) {
      const id = sealCpf(ring,tenant,envelopeId,p.id,p.cpf)
      await seed.query(`INSERT INTO contract_signature_participants(tenant_id,envelope_id,id,position,role,name,email,cpf_masked,
        identity_key_id,identity_nonce,identity_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [tenant,envelopeId,p.id,p.position,p.role,p.name,p.email,"***.***.***-"+p.cpf.slice(-2),id.identity_key_id,id.identity_nonce,id.identity_ciphertext])
    }
    await seed.query("INSERT INTO contract_signature_states(tenant_id,envelope_id,phase) VALUES($1,$2,'portal_pending')",[tenant,envelopeId])
    for (const [i,id] of docs.entries()) await seed.query(`INSERT INTO commercial_contract_files(id,tenant_id,contract_id,kind,position,sha256,content)
      VALUES($1,$2,$3,'signed',$4,$5,$6)`,[id,tenant,contract,i,sha256(bases[i]!),bases[i]])
    await assert.rejects(preparePersonalSignatures(txFor(randomUUID()),contract,validator),{status:404})
    await assert.rejects(preparePersonalSignatures(tx,contract,{...validator,trustBundleSha256:sha256("changed")}),{status:503})
    assert.equal((await preparePersonalSignatures(tx,contract,validator)).phase,"personal_signing")
    assert.equal((await preparePersonalSignatures(tx,contract,validator)).documentCount,2)
    let count = 0
    for (const p of participants) {
      for (const [i,documentId] of docs.entries()) {
        const input = {envelopeId,participantId:p.id,documentId}
        const head = await tx(c=>readSigningDocument(c,input))
        assert.ok(head.content.subarray(0,bases[i]!.length).equals(bases[i]!))
        const upload = { ...input,parentSha256:head.sha256,headRevision:head.headRevision,stageRevision:head.stageRevision,
          content:Buffer.concat([head.content,Buffer.from("\nconstructed signature revision "+p.position)]) }
        if (!count) {
          await assert.rejects(tx(c=>readSigningDocument(c,{...input,participantId:participants[2]!.id})),{status:409})
          await assert.rejects(uploadSigningDocument(tx,{...upload,headRevision:"99"},validator,ring),{status:409})
          const reject = { ...validator,increment:async () => { throw new ContractSignatureValidationError(422,"contract_signature_invalid","Assinatura inválida") } }
          await assert.rejects(uploadSigningDocument(tx,{...upload,content:Buffer.concat([upload.content,Buffer.from("bad")])},reject,ring),{status:422})
          assert.equal((await seed.query("SELECT count(*) FROM contract_signature_uploads WHERE status='rejected' AND quarantine_until>clock_timestamp()")).rows[0].count,"1")
          assert.equal((await seed.query("SELECT count(*) FROM contract_signature_revisions")).rows[0].count,"0")
          await seed.query("UPDATE contract_signature_uploads SET quarantine_until=now()-interval '1 second' WHERE status='rejected'")
          await tx(c=>cleanSignatureUploads(c,envelopeId))
          const oldBytes = (await seed.query("SELECT stored_bytes FROM contract_signature_states")).rows[0].stored_bytes
          await seed.query("UPDATE contract_signature_states SET stored_bytes=1073741824")
          await assert.rejects(uploadSigningDocument(tx,upload,validator,ring),{status:413})
          await seed.query("UPDATE contract_signature_states SET stored_bytes=$1",[oldBytes])
          let release!: () => void
          const wait = new Promise<void>(resolve => { release = resolve })
          let ready!: () => void
          const started = new Promise<void>(resolve => { ready = resolve })
          const slow = { ...validator,increment:async (...args:Parameters<ContractSignatureValidator["increment"]>) => {
            ready(); await wait; return validator.increment(...args)
          } }
          const pending = uploadSigningDocument(tx,upload,slow,ring)
          await Promise.race([started,pending.then(()=>{throw Error("Validation did not start")})])
          await assert.rejects(uploadSigningDocument(tx,upload,validator,ring),{code:"signature_validation_pending"})
          await seed.query("UPDATE contract_signature_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE status='leased'")
          await uploadSigningDocument(tx,upload,validator,ring)
          release()
          await assert.rejects(pending,{status:409})
        }
        const state = await uploadSigningDocument(tx,upload,validator,ring)
        assert.equal(state.phase,++count === 6 ? "completed" : "personal_signing")
        assert.equal(state.currentParticipant, i === 0 ? p.position : Math.min(3,p.position+1))
      }
    }
    const summary = (await seed.query(`SELECT (SELECT count(*) FROM contract_signature_evidence)::int AS proofs,
      (SELECT count(*) FROM contract_signature_revisions)::int AS revisions,(SELECT count(*) FROM contract_signature_heads WHERE sequence=3)::int AS heads,
      (SELECT count(*) FROM contract_signature_uploads)::int AS uploads,reserved_bytes,stored_bytes,
      (SELECT sum(octet_length(bundle)) FROM contract_signature_evidence)+(SELECT sum(octet_length(content)) FROM contract_signature_documents)
      +(SELECT sum(octet_length(content)) FROM contract_signature_revisions) AS expected FROM contract_signature_states`)).rows[0]
    assert.deepEqual(summary,{proofs:8,revisions:6,heads:2,uploads:0,reserved_bytes:"0",stored_bytes:summary.expected,expected:summary.expected})
  } finally {
    await seed.end()
    await admin.query("DROP DATABASE " + db)
    await admin.query("DROP ROLE IF EXISTS " + role)
    await admin.end()
  }
})
