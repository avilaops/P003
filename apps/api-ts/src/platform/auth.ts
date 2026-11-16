import { z } from "zod"

import { Problem } from "./problem.js"

const profileSchema = z.object({
  sub: z.string().trim().min(1),
  email: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  email_verified: z.boolean().default(false),
})

export type AuthenticatedIdentity = {
  subject: string
  email: string
  name: string
  emailVerified: boolean
}

export async function authenticate(
  authorization: string | undefined,
  userinfoUrl: string,
  fetchAuth: typeof fetch = fetch,
): Promise<AuthenticatedIdentity> {
  if (!authorization) throw new Problem(401, "missing_token", "Credencial de acesso ausente")
  const match = /^Bearer\s+(\S+)$/i.exec(authorization)
  if (!match?.[1]) throw new Problem(401, "invalid_token", "Credencial de acesso inválida")

  let response: Response
  try {
    response = await fetchAuth(userinfoUrl, {
      headers: { authorization: `Bearer ${match[1]}`, accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new Problem(503, "auth_unavailable", "Serviço de autenticação indisponível")
  }
  if (response.status === 401 || response.status === 403) {
    throw new Problem(401, "invalid_token", "Credencial de acesso inválida")
  }
  if (!response.ok) throw new Problem(503, "auth_unavailable", "Serviço de autenticação indisponível")
  const parsed = profileSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Problem(503, "auth_unavailable", "Serviço de autenticação indisponível")
  const email = parsed.data.email.toLowerCase()
  return {
    subject: parsed.data.sub,
    email,
    name: parsed.data.name ?? email,
    emailVerified: parsed.data.email_verified,
  }
}
