export function authContractProfile(token: string) {
  const profile: Record<string, unknown> = { sub: token, email: "reader@example.test" }
  if (token.startsWith("auth-fixture-") || token === "reader internal") profile.sub = "reader"
  if (token === "auth-fixture-null-name") profile.name = null
  if (token === "auth-fixture-empty-name") profile.name = "   "
  if (token === "auth-fixture-invalid") profile.email = 123
  const status = token === "auth-fixture-created" ? 201 : token === "auth-fixture-denied" ? 403 : 200
  return { profile, status }
}
