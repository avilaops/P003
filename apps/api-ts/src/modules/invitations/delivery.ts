// E-mail delivery of invitations goes through ERP Auth's provisioning endpoint.
// The interface is injectable so tests never contact a real service.
export type DeliveryOutcome = "sent" | "failed" | "unknown" | "limited"

export interface InvitationDelivery {
  send(invitation: { email: string; name: string }, company: string, inviter: string): Promise<DeliveryOutcome>
}

function trustedOrigin(value: string) {
  const url = new URL(value)
  const local = ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.username || url.password || !(url.protocol === "https:" || url.protocol === "http:" && local)) throw Error("Invitations require trusted HTTPS service origins")
  if (url.pathname !== "/" || url.search || url.hash) throw Error("Invitation service addresses must be origins")
  return url
}

export function provisioningDelivery(options: { endpoint: URL; clientId: string; secret: string; destination: string; fetcher?: typeof fetch }): InvitationDelivery {
  const fetcher = options.fetcher ?? fetch
  const authorization = `Basic ${Buffer.from(`${options.clientId}:${options.secret}`).toString("base64")}`
  return {
    async send(invitation, company, inviter) {
      let response: Response
      try {
        response = await fetcher(options.endpoint, {
          method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ email: invitation.email, nome: invitation.name, destino: options.destination, enviarConvite: true, empresa: company, convidadoPor: inviter }),
        })
      } catch { return "unknown" }
      if (response.status === 429) return "limited"
      if (!response.ok) return "failed"
      // Auth can return a password setup URL when mail fails. Never expose or persist it.
      try {
        const body = await response.json() as { envio?: unknown }
        return body.envio === "enviado" ? "sent" : body.envio === "limite" ? "limited" : "failed"
      } catch { return "unknown" }
    },
  }
}

// Same variables as the Rust service; absent credentials mean "not configured".
export function deliveryFromEnvironment(environment: NodeJS.ProcessEnv = process.env): InvitationDelivery | undefined {
  const clientId = environment.ERP_AUTH_CLIENT_ID ?? "", secret = environment.ERP_AUTH_CLIENT_SECRET ?? ""
  if (!clientId && !secret) return undefined
  if (!clientId || !secret) throw Error("Both ERP Auth client credentials are required for invitations")
  const issuer = trustedOrigin(environment.AUTH_ISSUER ?? ""), target = trustedOrigin(environment.ERP_WEB_ORIGIN ?? "https://erp.avilaops.com")
  return provisioningDelivery({ endpoint: new URL("/api/provisionamento/acessos", issuer), clientId, secret, destination: new URL("/preferencias/usuarios", target).toString() })
}
