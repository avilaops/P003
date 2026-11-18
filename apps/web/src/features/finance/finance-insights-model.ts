export type Side = "receivable" | "payable"
export type PortfolioRow = {
  id: string
  side: Side
  party: string
  partyId: string | null
  orderId: string | null
  operationId: string | null
  dueDate: string
  amount: string
  settled: string
  outstanding: string
  operationalOutstanding: string
  nextMovementOn: string | null
  status: string
  revision: string
}
export type Portfolio = {
  tenantId: string
  allowed: Side[]
  companyName: string
  asOf: string
  total: number
  rows: PortfolioRow[]
  totals: {
    weekReceivable: string
    weekPayable: string
    receivable: string
    payable: string
    overdueReceivable: string
    overduePayable: string
    openReceivables: number
    openPayables: number
    futureMovementTitles: number
  }
  buckets: { bucket: string; receivable: string; payable: string; count: number }[]
}
export const bucketLabels: Record<string, string> = {
  future: "A vencer",
  today: "Vence hoje",
  "1_30": "1 a 30 dias",
  "31_60": "31 a 60 dias",
  "61_90": "61 a 90 dias",
  over90: "Mais de 90 dias",
}
export const sideLabels = { receivable: "A receber", payable: "A pagar" }
export function titleUrl(row: { id: string; side: Side }) {
  return "/financeiro/" + (row.side === "receivable" ? "contas-receber" : "contas-pagar") + "/" + row.id
}
export function reais(amount: string) {
  const [integer, decimal = "00"] = amount.split(".")
  const absolute = BigInt(integer!.replace("-", ""))
  return (amount.startsWith("-") ? "−" : "") + "R$ " + absolute.toLocaleString("pt-BR") + "," + decimal.padEnd(2, "0")
}
export function overdueShare(overdue: string, outstanding: string) {
  const balance = BigInt(outstanding.replace(".", ""))
  if (!balance) return "Sem saldo em aberto"
  const basisPoints = (BigInt(overdue.replace(".", "")) * BigInt(10000) + balance / BigInt(2)) / balance
  return (basisPoints / BigInt(100)).toString() + "," + (basisPoints % BigInt(100)).toString().padStart(2, "0") + "%"
}
export function dateLabel(value: string) {
  return value.split("-").reverse().join("/")
}
export function localDay() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}
export const fieldStyle = "min-h-11 rounded-md border border-input bg-background px-3 py-2 text-sm"
