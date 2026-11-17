import { requirePermission, type AuthorizedContext } from "../../platform/access.js"

export function requireCommercialRead(context: AuthorizedContext) {
  if (context.permissions.includes("sales.proposals.read") && context.permissions.includes("sales.proposals.manage")) return
  requirePermission(context, "sales.orders.read")
}
