import { erpFetch } from "@/lib/api/client"
import type { FiscalReadiness } from "./nfe-draft-model"

export async function withModelReadiness(base: FiscalReadiness, model: number, environment: string, signal: AbortSignal): Promise<FiscalReadiness> {
  if (model !== 65) return base
  const unconfirmed = { ...base, model: 65, modelEnvironment:environment, canTransmit: false, blockers: [...base.blockers,"nfce_readiness_unavailable"] }
  try {
    const response = await erpFetch(`/api/erp/fiscal/nfce-readiness?environment=${encodeURIComponent(environment)}`, { signal, cache:"no-store" })
    if (!response.ok) return unconfirmed
    const result = await response.json()
    if (result.tenantId !== base.tenantId || result.model !== 65 || result.environment !== environment || !Array.isArray(result.blockers)) return unconfirmed
    return { ...base, model:65, modelEnvironment:environment, blockers:[...base.blockers,...result.blockers], canTransmit:base.canTransmit && result.blockers.length === 0 }
  } catch { return unconfirmed }
}
