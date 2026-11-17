import type { MixedSimulationInput, PriceTable, Sale, Director } from "./negotiation-types"

export type ProposalCustomer = { id?: string; personType: string; fiscal?: { taxpayerIndicator: string; stateRegistration?: string | null } | null; addresses?: { state: string; primary?: boolean }[] }
export type ProposalEquipment = { id: string; quantity: string; structureColor?: string; swingArmColor?: string; upholsteryColor?: string; plateHolderColor?: string; plateHolderType?: string }
export type ProposalTechnical = { dimensionsMm?: number[]; weight?: string; weightStack?: string; category?: string; photoDataUrl?: string | null; photoUrl?: string | null }
export type ProposalCommercial = { input: MixedSimulationInput; digest: string; sale: Omit<Sale, "items"> & { items: (Sale["items"][number] & { unitTotalCents?: number })[] }; personType?: string }
export type ProposalQuote = { simulation: MixedSimulationInput; digest: string; sale: ProposalCommercial["sale"]; director: Director | null }
export type ProposalPricingState = { status: "loading" | "generic" | "error"; quote?: undefined; message?: string } | { status: "ready"; quote: ProposalQuote }

function taxpayer(customer: ProposalCustomer) { return customer.personType === "juridica" && customer.fiscal?.taxpayerIndicator === "1" && Boolean(customer.fiscal.stateRegistration) }
export function proposalFiscalLabel(customer: ProposalCustomer) { return `${customer.personType === "fisica" ? "Pessoa física" : "Pessoa jurídica"} • ${taxpayer(customer) ? "Contribuinte de ICMS" : "Não contribuinte"}` }

export function proposalSimulationInput(items: ProposalEquipment[], tables: PriceTable[], customer: ProposalCustomer, input: Omit<MixedSimulationInput, "items" | "taxpayer">): MixedSimulationInput | null {
  const source = (id: string) => tables.flatMap(table => table.data?.items.filter(item => item.productId === id).map(item => ({ table, item })) ?? [])
  if (!items.some(item => source(item.id).length)) return null
  return { ...input, taxpayer: taxpayer(customer), items: items.map(item => {
    const matches = source(item.id)
    if (matches.length !== 1 || !matches[0].table.data || matches[0].item.available === false) throw Error("Todos os equipamentos precisam estar disponíveis em uma única tabela publicada por linha.")
    const quantity = Number(item.quantity.replace(",", "."))
    if (!/^\d+(?:[.,]0+)?$/.test(item.quantity) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw Error("Use quantidades inteiras de equipamentos na cotação comercial.")
    return { productId: item.id, line: matches[0].table.line, versionId: matches[0].table.data.id, quantity, structureColor: item.structureColor || null, swingArmColor: item.swingArmColor || null, upholsteryColor: item.upholsteryColor || null, plateHolderColor: item.plateHolderColor || null, plateHolderType: item.plateHolderType || null }
  }) }
}

export function proposalTechnicalSummary(technical: ProposalTechnical) {
  const dimensions = technical.dimensionsMm?.length === 3 && technical.dimensionsMm.every(value => Number.isSafeInteger(value) && value > 0)
    ? `${technical.dimensionsMm.map(value => value.toLocaleString("pt-BR")).join(" × ")} mm` : "Dimensões não informadas"
  return { dimensions, weight: `Peso: ${technical.weight?.trim() || "não informado"}`, stack: `Bateria: ${technical.weightStack?.trim() || (/bateria/i.test(technical.category || "") ? "não informada" : "não se aplica")}` }
}
