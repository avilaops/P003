import { StockPage } from "@/features/inventory/stock-access"

export const metadata = { title: "Novo lançamento de estoque" }
export default function Page() { return <StockPage path="/estoque/lancamentos/novo" /> }
