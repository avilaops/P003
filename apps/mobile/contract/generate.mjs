#!/usr/bin/env node
// Gera o cliente da API dos apps (Kotlin e Swift) a partir do contrato OpenAPI do api-ts.
// Uso: node apps/mobile/contract/generate.mjs [--check]
// O contrato é a fonte; a lista de operações usadas pelos apps fica em operations.json.
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")
export const outputs = {
  kotlin: "apps/mobile/android/core/src/main/kotlin/com/avilaops/erp/api/generated/ErpOperations.kt",
  swift: "apps/mobile/ios/ErpMobile/Api/Generated/ErpOperations.swift",
}
const header = "Gerado por apps/mobile/contract/generate.mjs a partir de apps/api-ts/openapi.json. Não edite."
const verbs = ["get", "put", "post", "delete", "patch"]

/** Resolve as operações que os apps usam. Falha quando o contrato e a lista divergem. */
export function resolveOperations(contract, manifest) {
  const byId = new Map()
  for (const [path, item] of Object.entries(contract.paths ?? {})) {
    for (const verb of verbs) {
      const operation = item[verb]
      if (!operation?.operationId) continue
      const parameters = operation.parameters ?? []
      byId.set(operation.operationId, {
        id: operation.operationId,
        method: verb.toUpperCase(),
        path,
        pathParameters: parameters.filter(p => p.in === "path").map(p => p.name),
        queryParameters: parameters.filter(p => p.in === "query").map(p => p.name),
        requiresTenant: (operation.security ?? []).some(entry => "tenantHeader" in entry),
        pendingOn: null,
      })
    }
  }
  const errors = [], result = []
  const pending = manifest.pending ?? {}
  for (const id of manifest.operations) {
    if (id in pending) errors.push(`${id} está em operations e em pending`)
    const operation = byId.get(id)
    if (!operation) errors.push(`${id} não existe em apps/api-ts/openapi.json`)
    else result.push(operation)
  }
  for (const [id, entry] of Object.entries(pending)) {
    if (byId.has(id)) { errors.push(`${id} já existe no contrato: mova de pending para operations`); continue }
    if (!verbs.includes(String(entry.method).toLowerCase()) || !String(entry.path).startsWith("/api/v1/") || !entry.waitingFor) {
      errors.push(`${id} em pending precisa de method, path /api/v1/... e waitingFor`)
      continue
    }
    result.push({
      id,
      method: entry.method.toUpperCase(),
      path: entry.path,
      pathParameters: [...entry.path.matchAll(/\{(\w+)\}/g)].map(match => match[1]),
      queryParameters: entry.queryParameters ?? [],
      requiresTenant: entry.requiresTenant !== false,
      pendingOn: entry.waitingFor,
    })
  }
  if (errors.length) throw new Error(errors.join("\n"))
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

const quote = value => JSON.stringify(value)
const list = (values, open, close) => values.length ? `${open}${values.map(quote).join(", ")}${close}` : `${open}${close}`

export function renderKotlin(operations) {
  const entries = operations.map(op => {
    const doc = op.pendingOn ? `    /** Fora do contrato TypeScript: aguardando ${op.pendingOn}. */\n` : ""
    return `${doc}    val ${op.id} = ErpOperation(
        id = ${quote(op.id)},
        method = ${quote(op.method)},
        path = ${quote(op.path)},
        pathParameters = ${list(op.pathParameters, "listOf(", ")")},
        queryParameters = ${list(op.queryParameters, "listOf(", ")")},
        requiresTenant = ${op.requiresTenant},
        pendingOn = ${op.pendingOn ? quote(op.pendingOn) : "null"},
    )`
  }).join("\n\n")
  return `// ${header}
package com.avilaops.erp.api.generated

import com.avilaops.erp.api.ErpOperation

object ErpOperations {
${entries}

    val all: List<ErpOperation> = listOf(${operations.map(op => op.id).join(", ")})
}
`
}

export function renderSwift(operations) {
  const entries = operations.map(op => {
    const doc = op.pendingOn ? `    /// Fora do contrato TypeScript: aguardando ${op.pendingOn}.\n` : ""
    return `${doc}    static let ${op.id} = ErpOperation(
        id: ${quote(op.id)},
        method: ${quote(op.method)},
        path: ${quote(op.path)},
        pathParameters: ${list(op.pathParameters, "[", "]")},
        queryParameters: ${list(op.queryParameters, "[", "]")},
        requiresTenant: ${op.requiresTenant},
        pendingOn: ${op.pendingOn ? quote(op.pendingOn) : "nil"}
    )`
  }).join("\n\n")
  return `// ${header}

enum ErpOperations {
${entries}

    static let all: [ErpOperation] = [${operations.map(op => op.id).join(", ")}]
}
`
}

async function main() {
  const check = process.argv.includes("--check")
  const manifest = JSON.parse(await readFile(join(root, "apps/mobile/contract/operations.json"), "utf8"))
  const contract = JSON.parse(await readFile(join(root, manifest.contract), "utf8"))
  const operations = resolveOperations(contract, manifest)
  const rendered = { kotlin: renderKotlin(operations), swift: renderSwift(operations) }
  let stale = false
  for (const [language, file] of Object.entries(outputs)) {
    const target = join(root, file)
    if (check) {
      const committed = await readFile(target, "utf8").catch(() => "")
      if (committed !== rendered[language]) { console.error(`${file} está desatualizado. Rode: node apps/mobile/contract/generate.mjs`); stale = true }
    } else {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, rendered[language])
    }
  }
  if (stale) process.exitCode = 1
  else console.log(check ? "Clientes mobile conferem com o contrato" : "Clientes mobile gerados")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
