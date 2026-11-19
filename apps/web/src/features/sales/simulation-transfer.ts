import type { SimulationInput } from "./negotiation-types"

export type SimulationTransfer = {
  tenantId: string
  input: SimulationInput
  digest: string
  totalCents: number
  approvalReasons: string[]
  companyFreight: boolean
  expiresAt: number
}

const prefix = "sales.simulation."
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function saveSimulationTransfer(storage: Store, key: string, value: Omit<SimulationTransfer,"expiresAt">, now = Date.now()) {
  if (!identifier.test(key)) throw Error("Identificador da simulação inválido.")
  storage.setItem(prefix+key, JSON.stringify({...value, expiresAt:now+2*60*60_000}))
}

export function readSimulationTransfer(storage: Store, key: string, tenantId: string, now = Date.now()): SimulationTransfer | null {
  if (!identifier.test(key)) return null
  try {
    const raw = storage.getItem(prefix+key)
    if (!raw || raw.length > 128_000) return null
    const transfer: SimulationTransfer = JSON.parse(raw)
    if (transfer.tenantId !== tenantId || !Number.isFinite(transfer.expiresAt)) return null
    if (transfer.expiresAt <= now) { storage.removeItem(prefix+key); return null }
    const input = transfer.input
    if (!input || !identifier.test(input.versionId) || !["imported","national"].includes(input.line)
      || !/^[a-f0-9]{64}$/.test(transfer.digest) || !Number.isSafeInteger(transfer.totalCents)
      || !Array.isArray(transfer.approvalReasons) || !transfer.approvalReasons.every(v=>typeof v==="string")
      || !input.discount || !["percent","amount","total"].includes(input.discount.kind) || !Number.isSafeInteger(input.discount.value)
      || !Array.isArray(input.items) || !input.items.length || input.items.length>100
      || !input.items.every(i=>i && identifier.test(i.productId) && Number.isInteger(i.quantity) && i.quantity>=1 && i.quantity<=1_000_000)) return null
    return transfer
  } catch { return null }
}
