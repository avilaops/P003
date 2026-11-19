import { Problem } from "../../platform/problem.js"

/**
 * L2 • Ávila Envios: contrato com o intermediador de frete.
 *
 * O ERP só conversa com transportadoras/intermediadores por esta interface. O provedor real
 * (credenciais, conta e API do Ávila Envios) ainda não foi definido: até lá a instalação usa
 * `unconfiguredFreightProvider`, que recusa com mensagem clara, e os testes injetam um stub.
 */
export type FreightAddress = { postalCode: string; state?: string; city?: string }
export type FreightPackage = { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number }
export type FreightQuoteInput = { origin: FreightAddress; destination: FreightAddress; packages: FreightPackage[]; declaredValueCents: number }
export type FreightOption = { serviceCode: string; serviceName: string; carrierName: string; priceCents: number; deliveryDays: number }
export type FreightContract = { providerReference: string; trackingCode: string | null }
export type FreightLabel = { format: "pdf" | "zpl"; labelCode: string; content: Buffer }
export type FreightTrackingEvent = { providerEventId: string; occurredAt: string; status: "posted" | "in_transit" | "out_for_delivery" | "delivered" | "exception"; description: string; location: string | null }

export interface FreightProvider {
  /** Identificador estável gravado em cada contratação (ex.: `avila-envios`). */
  readonly code: string
  quote(input: FreightQuoteInput): Promise<FreightOption[]>
  contract(input: FreightQuoteInput & { serviceCode: string; reference: string; recipientName: string }): Promise<FreightContract>
  label(providerReference: string): Promise<FreightLabel>
  track(providerReference: string): Promise<FreightTrackingEvent[]>
  cancel(providerReference: string): Promise<void>
}

const unavailable = (): never => {
  throw new Problem(503, "freight_provider_unavailable", "O Ávila Envios ainda não está configurado nesta instalação. Cotação, contratação, etiqueta e rastreio ficam indisponíveis até o provedor ser definido.")
}

export const unconfiguredFreightProvider: FreightProvider = {
  code: "unconfigured",
  quote: async () => unavailable(),
  contract: async () => unavailable(),
  label: async () => unavailable(),
  track: async () => unavailable(),
  cancel: async () => unavailable(),
}
