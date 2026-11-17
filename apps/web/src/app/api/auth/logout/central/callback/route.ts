import { cookies } from "next/headers"
import { connection, NextResponse } from "next/server"
import { cookieName, cookieOptions, validLogoutFlow } from "@/server/auth/erp-session"

/** Consome a saída pendente sem apagar uma sessão iniciada depois dela. */
export async function GET() {
  await connection()
  const jar = await cookies()
  if (!validLogoutFlow(jar.get(cookieName("logout"))?.value || "", "callback")) {
    return Response.json({ title: "Tentativa de saída inválida ou expirada" }, { status: 403, headers: { "Cache-Control": "no-store" } })
  }
  jar.set(cookieName("logout"), "", cookieOptions(0))
  const response = NextResponse.redirect("https://avilaops.com/", 303)
  response.headers.set("Cache-Control", "no-store")
  return response
}
