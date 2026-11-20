// Apoio aos testes CT-e: motor fiscal simulado (nunca chama a SEFAZ) e sementes de documentos.
import { createHash, randomUUID } from "node:crypto"
import type { FiscalOperation, FiscalOperations } from "../src/modules/fiscal-workspace/engine.js"
import type { TestContext } from "./support/test-context.js"
import { CTE_COMPANY } from "./fixtures/fiscal/cte.js"

export type EngineCall = { operation: FiscalOperation; input: Record<string, unknown> }
/** `respond` decide a resposta de cada chamada; `calls` registra o que a API enviou. */
export function fakeEngine(respond: (call: EngineCall) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const calls: EngineCall[] = []
  const operations: FiscalOperations = {
    async call(operation, input) { const call = { operation, input }; calls.push(call); return respond(call) },
    async material() { return { issuerTaxId: CTE_COMPANY, certificate: { pkcs12Base64: "ZmljdGljaW8=", password: "senha-ficticia" } } },
    production: () => false,
    async nfceSecret() { return {} },
  }
  return { operations, calls }
}

export const actorHeader = (subject: string) => ({ "x-actor-subject": Buffer.from(subject).toString("base64url") })

/** Grava um CT-e já distribuído direto no banco (como se viesse de uma execução anterior). */
export async function seedCteDocument(ctx: TestContext, xml: string, { tenant = ctx.tenant, nsu = "000000000000001", schema = "procCTe_v4.00.xsd", kind = "full", tax = CTE_COMPANY } = {}) {
  const run = randomUUID(), id = randomUUID()
  await ctx.seed.query(`INSERT INTO fiscal_cte_distribution_runs(tenant_id,id,environment,company_tax_id,author_state,auth_subject,command_key,requested_nsu,status)
    VALUES($1,$2,2,$3,'SP','seed',$4,'000000000000000','completed')`, [tenant, run, tax, randomUUID()])
  await ctx.seed.query(`INSERT INTO fiscal_cte_distribution_documents(tenant_id,id,run_id,environment,company_tax_id,nsu,schema_name,kind,xml,xml_sha256)
    VALUES($1,$2,$3,2,$4,$5,$6,$7,$8,$9)`, [tenant, id, run, tax, nsu, schema, kind, xml, createHash("sha256").update(xml).digest("hex")])
  return id
}
