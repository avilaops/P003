import { erpHealthOrigins } from "@/server/bff/erp-backend"

export async function GET() {
  try {
    const origins = erpHealthOrigins(process.env.ERP_API_URL || "http://127.0.0.1:8080", {
      ERP_TYPESCRIPT_MODULES: process.env.ERP_TYPESCRIPT_MODULES,
      ERP_TYPESCRIPT_API_URL: process.env.ERP_TYPESCRIPT_API_URL,
    })
    const readiness = await Promise.all(origins.map(async origin => {
      const response = await fetch(`${origin}/health/ready`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) })
      if (!response.ok) { await response.body?.cancel(); return false }
      const value: unknown = await response.json()
      return typeof value === "object" && value !== null && "status" in value && value.status === "ready"
    }))
    const ready = readiness.every(Boolean)
    return Response.json({ ok: ready, application: "erp-next", commit: process.env.ERP_RELEASE_SHA || "unknown" }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ ok: false, application: "erp-next" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
