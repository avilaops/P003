import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authenticateRequest, authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { RegistryClient } from "./client.js"
import { normalizeLookup, type RegistryProvider } from "./model.js"

const lookupSchema = z.strictObject({ kind: z.enum(["cep", "cnpj", "ie"]), context: z.enum(["company", "party"]), value: z.string(), state: z.string().nullish().transform(value => value ?? null) })
const registrationSchema = z.strictObject({ value: z.string() })
const unavailable = () => new Problem(409, "domain_conflict", "Consulta cadastral indisponível. Continue o preenchimento manual")

// `registry` lets tests (or a future AppDependencies field) replace the providers; `null` means unavailable.
type Injected = AppDependencies & { registry?: RegistryProvider | null }

export function registerRegistryLookupRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  const injected = (dependencies as Injected).registry
  const registry = injected === undefined ? RegistryClient.fromEnvironment() : injected ?? undefined
  app.post("/api/v1/registry-lookups", async (request, reply) => {
    const parsed = lookupSchema.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Envie os parâmetros da consulta cadastral")
    const permission = parsed.data.context === "company" ? "platform.company.read" : "catalog.parties.read"
    const check = () => authorizeRequest(request, dependencies, async context => { requirePermission(context, permission); return context.tenantId })
    const tenant = await check()
    const input = normalizeLookup(parsed.data)
    if (!registry) throw unavailable()
    const result = await registry.lookup(tenant, input)
    // Rights may have been revoked while waiting for a provider.
    await check()
    return reply.header("cache-control", "no-store").send(result)
  })

  // Read-only sign-up lookup: needs a signed-in identity but no company.
  app.post("/api/v1/company-registration/lookup", async (request, reply) => {
    const identity = await authenticateRequest(request, dependencies)
    const parsed = registrationSchema.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Informe somente o CNPJ da empresa")
    const input = normalizeLookup({ kind: "cnpj", context: "company", value: parsed.data.value, state: null })
    if (!registry) throw unavailable()
    const { tenantId: _tenant, kind: _kind, cached: _cached, attempts: _attempts, ...reply_ } = await registry.lookupRegistration(identity.subject, input)
    return reply.header("cache-control", "no-store").send(reply_)
  })
}
