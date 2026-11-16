import test from "node:test"
import assert from "node:assert/strict"
import { commercialProposal, proposalState } from "../src/features/sales/order-proposal-model.ts"

const sale = { items: [{ productId: "1", sku: "EQ-1", name: "Equipamento nacional", quantity: 2, tableUnitCents: 10000, netCents: 18000, ipiCents: 1800, totalCents: 19800 }, { productId: "2", sku: "EQ-2", name: "Equipamento importado", quantity: 1, tableUnitCents: 5000, netCents: 4500, ipiCents: 900, totalCents: 5400 }], tableTotalCents: 25000, discountCents: 2500, discountBps: 1000, netSaleCents: 22500, ipiBps: null, ipiCents: 2700, totalCents: 25200, minimumDownPaymentBps: null, minimumDownPaymentCents: 10000, downPaymentCents: 11000, freightCents: 500, approvalReasons: [], equipmentCostCents: 17000, netProfitCents: 5000, director: { password: "NEVER_EXPORT" } }

test("estado nunca libera cálculo ausente, pendente ou sujeito a aprovação", () => {
  assert.equal(proposalState(null, false), "Em preenchimento")
  assert.equal(proposalState(sale, true), "Calculando")
  assert.equal(proposalState(sale, false), "Liberado")
  assert.equal(proposalState({ ...sale, approvalReasons: ["desconto-acima-do-livre"] }, false), "Requer aprovação")
})

test("cópia usa lista comercial explícita, quantidades e IPI misto sem percentual inventado", () => {
  const proposal = commercialProposal(sale, { destinationState: "SP", taxpayer: false, paymentTerms: "Saldo em duas parcelas", deliveryTerms: "Entrega a combinar" })
  assert.match(proposal.text, /Proposta comercial • não salva/)
  assert.match(proposal.text, /Equipamento nacional/)
  assert.match(proposal.text, /Quantidade: 2/)
  assert.match(proposal.text, /IPI: R\$\s*27,00/)
  assert.match(proposal.text, /Entrada negociada: R\$\s*110,00/)
  assert.match(proposal.text, /Saldo em duas parcelas/)
  assert.equal(proposal.totals.some(([label]) => /IPI.*%|Entrada mínima.*%/.test(label)), false)
  assert.doesNotMatch(JSON.stringify(proposal), /equipmentCost|netProfit|director|NEVER_EXPORT|17000|margem|lucro|custo/i)
  assert.equal(proposal.rows.length, 2)
  const freightSentinel = commercialProposal({ ...sale, freightCents: 12345 }, { destinationState: "SP", taxpayer: false, deliveryTerms: "Frete por conta da empresa" })
  assert.doesNotMatch(freightSentinel.text, /123,45/)
  assert.equal(freightSentinel.totals.some(([label]) => label === "Frete"), false)
})

test("proposta mantém percentuais uniformes quando presentes", () => {
  const proposal = commercialProposal({ ...sale, ipiBps: 1300, minimumDownPaymentBps: 5000 }, { destinationState: "MG", taxpayer: true, customerName: "Cliente registrado" })
  assert.match(proposal.text, /IPI \(13%\)/)
  assert.match(proposal.text, /Entrada mínima \(50%\)/)
  assert.match(proposal.text, /Cliente registrado/)
  assert.match(proposal.text, /Requer aprovação|Liberado/)
})
