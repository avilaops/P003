export type FinancialAccount = {
  id: string
  customerName?: string
  supplierName?: string
  amount: string
  outstandingAmount: string
  status: "open" | "paid" | "cancelled"
  dueDate: string
}

export type FinancialResult = { tenantId?: string; data: FinancialAccount[] }

export type StockItem = {
  productId: string
  sku: string
  name: string
  unit: string
  status: string
  quantity: string
  reserved: string
  available: string
}

export type StockResult = { tenantId?: string; data: StockItem[]; total: number; offset: number; limit: number }

export function decimal(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
}

export function financeMetrics(receivables: FinancialAccount[], payables: FinancialAccount[]) {
  return {
    toReceive: receivables.filter(item => item.status !== "cancelled").reduce((sum, item) => sum + decimal(item.outstandingAmount), 0),
    toPay: payables.filter(item => item.status !== "cancelled").reduce((sum, item) => sum + decimal(item.outstandingAmount), 0),
    openReceivables: receivables.filter(item => item.status === "open").length,
    openPayables: payables.filter(item => item.status === "open").length,
  }
}

export function financeRows(receivables: FinancialAccount[], payables: FinancialAccount[]) {
  return [
    ...receivables.map(item => ({ ...item, kind: "A receber", party: item.customerName || "Cliente não informado" })),
    ...payables.map(item => ({ ...item, kind: "A pagar", party: item.supplierName || "Fornecedor não informado" })),
  ]
}

export function stockMetrics(result: StockResult | null) {
  const items = result?.data || []
  const grouped=(key:"quantity"|"reserved")=>{
    const units=new Map<string,bigint>()
    for(const item of items){
      const [whole,fraction=""]=item[key].split(".")
      const micros=BigInt(whole+fraction.padEnd(6,"0"))
      units.set(item.unit,(units.get(item.unit)||BigInt(0))+micros)
    }
    return [...units].map(([unit,micros])=>{
      const scale=BigInt(1000000)
      const fraction=String(micros%scale).padStart(6,"0").replace(/0+$/,"")
      return (micros/scale).toLocaleString("pt-BR")+(fraction?","+fraction:"")+" "+unit
    }).join(" • ")||"0"
  }
  return {
    products: result?.total || 0,
    quantity: grouped("quantity"),
    reserved: grouped("reserved"),
    unavailable: items.filter(item => decimal(item.available) <= 0).length,
  }
}

export function financeExportRows(receivables: FinancialAccount[], payables: FinancialAccount[]) {
  return [
    ["Tipo", "Contraparte", "Valor", "Saldo", "Situação", "Vencimento"],
    ...receivables.map(item => ["A receber", item.customerName || "", item.amount, item.outstandingAmount, item.status, item.dueDate]),
    ...payables.map(item => ["A pagar", item.supplierName || "", item.amount, item.outstandingAmount, item.status, item.dueDate]),
  ]
}

export function stockExportRows(items: StockItem[]) {
  return [
    ["SKU", "Produto", "Unidade", "Saldo", "Reservado", "Disponível", "Situação"],
    ...items.map(item => [item.sku, item.name, item.unit, item.quantity, item.reserved, item.available, item.status]),
  ]
}
