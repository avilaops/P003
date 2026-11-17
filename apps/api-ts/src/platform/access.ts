import { z } from "zod"

import { authenticate, type AuthenticatedIdentity } from "./auth.js"
import { withTenantTransaction, type DatabasePool, type TenantContext } from "./database.js"
import { Problem } from "./problem.js"
import { currentVerifiedMcpIdentity } from "./request-identity.js"

type RequestLike = { method?: string; headers: Record<string, string | string[] | undefined> }

export type AccessDependencies = {
  pool: DatabasePool
  userinfoUrl: string
  fetchAuth?: typeof fetch
  mcpResource?: string
}

export type AuthorizedContext = TenantContext & { identity: AuthenticatedIdentity }
const tenantSchema = z.guid()
const authenticatedRequests = new WeakMap<object, AuthenticatedIdentity>()

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value
}

export async function authenticateRequest(request: RequestLike, dependencies: AccessDependencies) {
  const cached = authenticatedRequests.get(request)
  if (cached) return cached
  const identity = currentVerifiedMcpIdentity() ?? await authenticate(singleHeader(request.headers.authorization), dependencies.userinfoUrl, dependencies.fetchAuth)
  authenticatedRequests.set(request, identity)
  return identity
}

export async function authorizeRequest<T>(
  request: RequestLike,
  dependencies: AccessDependencies,
  operation: (context: AuthorizedContext) => Promise<T>,
  write = request.method !== undefined && !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()),
): Promise<T> {
  const identity = await authenticateRequest(request, dependencies)
  const rawTenant = singleHeader(request.headers["x-tenant-id"])
  if (rawTenant === undefined) throw new Problem(400, "missing_tenant", "Empresa ativa não informada")
  if (!tenantSchema.safeParse(rawTenant).success) {
    throw new Problem(400, "invalid_tenant", "Identificador da empresa inválido")
  }
  return withTenantTransaction(dependencies.pool, rawTenant.toLowerCase(), identity.subject, context =>
    operation({ ...context, identity }),
    write,
  )
}

export function requirePermission(context: TenantContext, permission: string) {
  if (!context.permissions.includes(permission)) {
    throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
  }
}
