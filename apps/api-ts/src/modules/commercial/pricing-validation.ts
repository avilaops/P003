import { z } from "zod"
import { Problem } from "../../platform/problem.js"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { reloadTenantPermissions } from "../../platform/database.js"

export const publicationManager = "platform.company.manage"
export const lineSchema = z.enum(["imported","national"])

export function pricingInput<T>(schema:z.ZodType<T>,raw:unknown) {
  const parsed = schema.safeParse(raw)
  if(!parsed.success) throw new Problem(422,"invalid_input","Dados comerciais inválidos ou campos desconhecidos")
  return parsed.data
}

export async function lockPricingSnapshot(context: AuthorizedContext) {
  await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [context.tenantId])
  await reloadTenantPermissions(context)
  requirePermission(context,publicationManager)
}

export function stale(): never {
  throw new Problem(412,"revision_conflict","Os dados mudaram. Recarregue e prepare uma nova prévia")
}
