import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { FastifyInstance } from "fastify"

type Step = {
  name: string
  parameters: {
    jsCode?: string
    url?: string
    value?: string
    jsonBody?: string
    headerParameters?: { parameters: { name: string; value: string }[] }
    options?: { redirect: { redirect: { followRedirects: boolean } } }
    provideSslCertificates?: boolean
    type?: string
  }
}

// Run the exported Code nodes and the request expressions with n8n's single-item input contract.
export async function checkStatementWorkflow(
  app: FastifyInstance,
  tenant: string,
  account: string,
  otherAccount: string,
  authorization: string,
  statement: string,
) {
  const path = new URL("../../../docs/integrations/n8n-financeiro-extrato-efi.json", import.meta.url)
  const exported = JSON.parse(await readFile(path, "utf8")) as { active: boolean; nodes: Step[] }
  const nodes = new Map(exported.nodes.map((step) => [step.name, step.parameters]))
  const outputs = new Map<string, unknown>()
  const item = (json: unknown) => ({ first: () => ({ json }) })
  const lookup = (name: string) => item(outputs.get(name))
  function run(name: string, json: unknown) {
    const code = nodes.get(name)?.jsCode
    assert.ok(code)
    const output = new Function("$input", "$", code)(item(json), lookup)[0].json
    outputs.set(name, output)
    return output
  }
  function evaluate(expression: string | undefined, json: unknown) {
    assert.ok(expression?.startsWith("={{") && expression.endsWith("}}"))
    return new Function("$json", "$", "return (" + expression!.slice(3, -2) + ")")(json, lookup)
  }

  assert.equal(exported.active, false)
  for (const name of ["Autorizar na Efí", "Listar extratos", "Baixar extrato"]) {
    assert.equal(nodes.get(name)?.provideSslCertificates, true)
    assert.equal(nodes.get(name)?.options?.redirect.redirect.followRedirects, false)
  }
  const filename = "extrato_2026-01.txt"
  const config = { apiErp: "https://erp-api.example.test", tenantId: tenant, accountId: account, nomeArquivo: filename }
  const list = [{ nome: filename, data_geracao: "2026-02-01", periodo_inicio: "2026-01-01", periodo_fim: "2026-01-31" }]
  run("Conferir configuração", { ...config, nomeArquivo: "" })
  assert.equal(run("Escolher extrato", { statusCode: 200, body: list }).arquivos[0].nome, filename)
  assert.throws(() => run("Conferir configuração", { ...config, nomeArquivo: "../extrato" }))
  run("Conferir configuração", config)
  assert.throws(() => run("Escolher extrato", { statusCode: 200, body: [] }))
  assert.throws(() => run("Escolher extrato", { statusCode: 200, body: [...list, ...list] }))
  const selected = run("Escolher extrato", { statusCode: 200, body: list })
  assert.equal(
    evaluate(nodes.get("Baixar extrato")?.url, selected),
    "https://extratos.api.efipay.com.br/v1/extrato-cnab/download/" + filename,
  )

  async function submit(content: string, accountId = account) {
    run("Conferir configuração", { ...config, accountId })
    outputs.set("Baixar extrato", { statusCode: 200, body: content })
    const crypto = nodes.get("Identificar arquivo")!
    const digest = createHash(crypto.type!).update(evaluate(crypto.value, selected)).digest("hex")
    const command = run("Preparar importação", { digest })
    const post = nodes.get("Importar no ERP")!
    const requestHeaders = Object.fromEntries(
      post.headerParameters!.parameters.map((h) => [h.name, evaluate(h.value, command)]),
    )
    const url = new URL(evaluate(post.url, command))
    assert.equal(url.origin, config.apiErp)
    return app.inject({
      method: "POST",
      url: url.pathname,
      headers: { ...requestHeaders, authorization },
      payload: evaluate(post.jsonBody, command),
    })
  }

  await assert.rejects(submit("https://unknown.example/statement"), /CNAB 240/)
  assert.equal((await submit(statement, otherAccount)).statusCode, 409)
  const first = await submit(statement)
  assert.equal(first.statusCode, 201, first.body)
  const protocol = run("Conferir protocolo", {
    statusCode: first.statusCode,
    headers: first.headers,
    body: first.json(),
  })
  assert.equal(protocol.linhasImportadasNoComando, 1)
  assert.equal(protocol.repeticao, false)
  const same = await submit(JSON.stringify(statement))
  assert.equal(same.statusCode, 201, same.body)
  const repeated = run("Conferir protocolo", { statusCode: same.statusCode, headers: same.headers, body: same.json() })
  assert.equal(repeated.extratoId, protocol.extratoId)
  assert.equal(repeated.repeticao, true)
  assert.equal((await submit(statement.replace("CREDITO", "DEPOSITO"))).statusCode, 409)
  assert.throws(() => run("Conferir protocolo", { statusCode: 201, body: { ...first.json(), tenantId: otherAccount } }))
}
