import { cookies } from "next/headers"
import { connection, NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { authEndpoints, cookieName, cookieOptions, erpConfiguration, seal, validLogoutFlow } from "@/server/auth/erp-session"

/** Continua somente a saída iniciada pelo POST de mesma origem. */
export async function GET() {
  await connection()
  try {
    const config = erpConfiguration()
    const jar = await cookies()
    if (!validLogoutFlow(jar.get(cookieName("logout"))?.value || "", "start") || jar.get(cookieName("session"))?.value) {
      return Response.json({ title: "Tentativa de saída inválida ou expirada" }, { status: 403, headers: { "Cache-Control": "no-store" } })
    }
    const { logout } = await authEndpoints()
    if (!logout || !config.clientId) throw new Error("Saída central não configurada")
    const location = new URL(logout)
    location.searchParams.set("client_id", config.clientId)
    location.searchParams.set("post_logout_redirect_uri", `${config.origin}/api/auth/logout/central/callback`)
    jar.set(cookieName("logout"), seal({ phase: "callback", expiresAt: Date.now() + 120_000 }, "erp-logout"), cookieOptions(120))
    const nonce = randomBytes(18).toString("base64")
    const action = location.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    return new NextResponse(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Saindo…</title></head><body><form id="logout" method="post" action="${action}"></form><script nonce="${nonce}">document.getElementById("logout").submit()</script><noscript><button form="logout" type="submit">Continuar saída</button></noscript></body></html>`, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "origin",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${config.issuer} ${config.origin} https://avilaops.com; base-uri 'none'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch {
    return Response.json({ title: "A sessão local foi encerrada, mas não foi possível confirmar a saída do Ávila Auth" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
