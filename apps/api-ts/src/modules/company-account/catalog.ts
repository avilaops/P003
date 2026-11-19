// Catálogo comercial inicial aprovado pelo responsável do produto.
// Cotas ausentes de importação não são inferidas de outra faixa.
export type Plan = { id: string; name: string; monthlyCents: number; dataMegabytes: number; users: number | null; importedOrders: number | null; customQuote: boolean }

export const plans: readonly Plan[] = [
  { id: "cobalto", name: "Cobalto", monthlyCents: 6000, dataMegabytes: 60, users: 5, importedOrders: 200, customQuote: false },
  { id: "titanio-1", name: "Titânio Faixa 1", monthlyCents: 12000, dataMegabytes: 120, users: 50, importedOrders: null, customQuote: false },
  { id: "titanio-2", name: "Titânio Faixa 2", monthlyCents: 20000, dataMegabytes: 360, users: 50, importedOrders: null, customQuote: false },
  { id: "titanio-3", name: "Titânio Faixa 3", monthlyCents: 45000, dataMegabytes: 1200, users: 50, importedOrders: null, customQuote: false },
  { id: "diamante", name: "Diamante", monthlyCents: 65000, dataMegabytes: 1800, users: 100, importedOrders: null, customQuote: false },
  { id: "elite", name: "Elite", monthlyCents: 125000, dataMegabytes: 5000, users: null, importedOrders: null, customQuote: true },
]

export const findPlan = (id: string | undefined | null) => plans.find(plan => plan.id === id)
