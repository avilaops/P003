import { AsyncLocalStorage } from "node:async_hooks"
import type { AuthenticatedIdentity } from "./auth.js"

// Only the private MCP dispatcher enters this context, after validating its grant.
// Incoming identity headers are never used to populate it.
const verifiedMcpIdentity = new AsyncLocalStorage<AuthenticatedIdentity>()

export function currentVerifiedMcpIdentity() { return verifiedMcpIdentity.getStore() }

// `operation` must await app.inject(): light-my-request dispatches lazily, on `then`,
// so a returned (not awaited) inject would run outside this context.
export function runWithMcpIdentity<T>(identity: AuthenticatedIdentity, operation: () => T): T {
  return verifiedMcpIdentity.run(Object.freeze({ ...identity }), operation)
}
