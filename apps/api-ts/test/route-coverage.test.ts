import assert from "node:assert/strict"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { formatCoverage, routeCoverage } from "./support/route-coverage.js"

// Por enquanto só RELATA as rotas sem teste. Para virar obrigatório (PRs de porte, depois da lacuna fechada):
// ROUTE_COVERAGE_ENFORCE=1 pnpm --filter api-ts test   — ou troque o padrão abaixo para "1".
const enforce = (process.env.ROUTE_COVERAGE_ENFORCE ?? "0") === "1"

test("cobertura de rotas: lista as rotas registradas sem teste de sucesso e de acesso negado", async t => {
  const app = buildApp({ pool: { async connect() { throw Error("sem banco") } }, userinfoUrl: "https://auth.example.invalid/userinfo" })
  try {
    await app.ready()
    const result = await routeCoverage(app)
    for (const line of formatCoverage(result).split("\n")) t.diagnostic(line)
    assert.deepEqual(result.unknown, [], "títulos de teste citam rotas que não existem")
    if (enforce) assert.deepEqual(result.missing, [], "há rotas sem teste de sucesso e de acesso negado (veja o diagnóstico)")
  } finally { await app.close() }
})
