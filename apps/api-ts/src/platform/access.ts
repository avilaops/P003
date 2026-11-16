import { z } from "zod"

import { authenticate, type AuthenticatedIdentity } from "./auth.js"
import { withTenantTransaction, type DatabasePool, type TenantContext } from "./database.js"
import { Problem } from "./problem.js"

type RequestLike = { headers: Record<string, string | string[] | undefined> }

export type AccessDependencies = {
  pool: DatabasePool
  userinfoUrl: string
  fetchAuth?: typeof fetch
}

export type AuthorizedContext = TenantContext & { identity: AuthenticatedIdentity }
const tenantSchema = z.string().uuid()

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value
}

export async function authorizeRequest<T>(
  request: RequestLike,
  dependencies: AccessDependencies,
  operation: (context: AuthorizedContext) => Promise<T>,
): Promise<T> {
  const identity = await authenticate(
    singleHeader(request.headers.authorization),
    dependencies.userinfoUrl,
    dependencies.fetchAuth,
  )
  const rawTenant = singleHeader(request.headers["x-tenant-id"])
  if (!rawTenant) throw new Problem(400, "missing_tenant", "Empresa ativa não informada")
  if (!tenantSchema.safeParse(rawTenant).success) {
    throw new Problem(400, "invalid_tenant", "Identificador da empresa inválido")
  }
  return withTenantTransaction(dependencies.pool, rawTenant, identity.subject, context =>
    operation({ ...context, identity }),
  )
}

export function requirePermission(context: TenantContext, permission: string) {
  if (!context.permissions.includes(permission)) {
    throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
  }
}
