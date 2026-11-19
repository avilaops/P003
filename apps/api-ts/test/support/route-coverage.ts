import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { FastifyInstance } from "fastify"
import { openApiPath, registeredRoutes } from "../../src/platform/openapi.js"

/**
 * Cobertura de rotas: toda rota registrada precisa de um teste de sucesso e um de acesso negado.
 * O teste declara o que cobre no próprio título:
 *
 *   test("GET /api/v1/parties [sucesso] lista com catalog.parties.read", ...)
 *   test("GET /api/v1/parties [negado] sem permissão, sem token e de outra empresa", ...)
 *
 * Várias rotas no mesmo título: "GET /a + POST /a [negado] ...". Parâmetros: `{id}` ou `:id`.
 */
export type CoverageKind = "sucesso" | "negado"
export type RouteStatus = { route: string; sucesso: boolean; negado: boolean }

/** Rotas públicas por desenho: não têm cenário de acesso negado. */
export const publicRoutes = new Set(["GET /health/live", "GET /health/ready"])

const marker = /((?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s"'`[\]]*(?:\s*[,+]\s*(?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s"'`[\]]*)*)\s*\[(sucesso|negado)\]/g
export const normalize = (route: string) => route.replace(/\{[^}]*\}|:\w+\??/g, "{}")

async function testFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await testFiles(path))
    else if (entry.name.endsWith(".test.ts") && entry.name !== "route-coverage.test.ts") found.push(path)
  }
  return found
}

/** Lê os títulos dos testes e devolve `"METHOD /caminho{}"` → tipos cobertos. */
export async function declaredCoverage(directory = fileURLToPath(new URL("../", import.meta.url))) {
  const declared = new Map<string, Set<CoverageKind>>()
  for (const file of await testFiles(directory)) {
    for (const match of (await readFile(file, "utf8")).matchAll(marker)) {
      for (const route of match[1]!.split(/\s*[,+]\s*/)) {
        const key = normalize(route.trim().replace(/\s+/g, " "))
        ;(declared.get(key) ?? declared.set(key, new Set()).get(key)!).add(match[2] as CoverageKind)
      }
    }
  }
  return declared
}

export async function routeCoverage(app: FastifyInstance, directory?: string) {
  const declared = await declaredCoverage(directory)
  const routes = [...new Set(registeredRoutes(app).map(route => `${route.method} ${openApiPath(route.path)}`))].sort((a, b) => a.split(" ")[1]!.localeCompare(b.split(" ")[1]!) || a.localeCompare(b))
  const rows: RouteStatus[] = routes.filter(route => !publicRoutes.has(route)).map(route => {
    const kinds = declared.get(normalize(route))
    return { route, sucesso: kinds?.has("sucesso") ?? false, negado: kinds?.has("negado") ?? false }
  })
  const missing = rows.filter(row => !row.sucesso || !row.negado)
  const known = new Set(routes.map(normalize))
  return {
    total: rows.length,
    covered: rows.length - missing.length,
    missing,
    /** Títulos que citam rotas que não existem mais (typo ou rota removida). */
    unknown: [...declared.keys()].filter(route => !known.has(route)),
  }
}

export function formatCoverage(result: Awaited<ReturnType<typeof routeCoverage>>) {
  const lines = [`Rotas com sucesso e acesso negado testados: ${result.covered}/${result.total}; sem teste completo: ${result.missing.length}.`]
  for (const row of result.missing) lines.push(`  ${row.route} — falta: ${[row.sucesso ? "" : "sucesso", row.negado ? "" : "negado"].filter(Boolean).join(" e ")}`)
  for (const route of result.unknown) lines.push(`  título cita rota inexistente: ${route}`)
  return lines.join("\n")
}
