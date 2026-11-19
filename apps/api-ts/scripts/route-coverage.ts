import { appendFileSync } from "node:fs"
import { buildApp } from "../src/app.js"
import { formatCoverage, routeCoverage } from "../test/support/route-coverage.js"

// Imprime a lacuna de cobertura de rotas (e a anexa ao resumo do job quando roda no GitHub Actions).
const app = buildApp({ pool: { async connect() { throw Error("sem banco") } }, userinfoUrl: "https://auth.example.invalid/userinfo" })
try {
  await app.ready()
  const result = await routeCoverage(app)
  console.log(formatCoverage(result))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Cobertura de rotas do api-ts\n\n- Rotas com teste de sucesso e de acesso negado: **${result.covered}/${result.total}**\n- Sem teste completo: **${result.missing.length}**\n`)
  if (process.env.ROUTE_COVERAGE_ENFORCE === "1" && result.missing.length) process.exitCode = 1
} finally { await app.close() }
