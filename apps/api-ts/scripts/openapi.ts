import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { buildApp } from "../src/app.js"
import { buildOpenApiDocument } from "../src/platform/openapi.js"

// Gera (ou, com --check, confere) o contrato versionado em apps/api-ts/openapi.json.
const file = fileURLToPath(new URL("../openapi.json", import.meta.url))
const app = buildApp({
  pool: { async connect() { throw Error("A geração do contrato não acessa o banco") } },
  userinfoUrl: "https://auth.example.invalid/userinfo",
  fetchAuth: async () => { throw Error("A geração do contrato não acessa o Auth") },
})
try {
  await app.ready()
  const generated = JSON.stringify(buildOpenApiDocument(app), null, 2) + "\n"
  if (process.argv.includes("--check")) {
    const committed = await readFile(file, "utf8").catch(() => "")
    if (committed !== generated) {
      console.error("apps/api-ts/openapi.json está desatualizado em relação às rotas registradas. Rode: pnpm --filter api-ts openapi")
      process.exitCode = 1
    } else console.log("openapi.json confere com as rotas registradas")
  } else {
    await writeFile(file, generated)
    console.log("openapi.json gerado")
  }
} finally { await app.close() }
