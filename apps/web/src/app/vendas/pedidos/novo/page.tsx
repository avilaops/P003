import { Suspense } from "react"
import { readCommercialTableQuery } from "@/features/sales/commercial-navigation-model"
import { OrdersAccess } from "@/features/sales/orders-access"
type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> }
export default function Page(props: PageProps) { return <Suspense fallback={<p role="status">Carregando pedido…</p>}><NewOrder {...props} /></Suspense> }
async function NewOrder({ searchParams }: PageProps) {
  const params = await searchParams
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (typeof value === "string") search.set(key, value)
  const query = readCommercialTableQuery(search)
  return <OrdersAccess create commercialCreate={params.modo !== "catalogo"} prefill={{initialLine:query.line, initialItems:query.items, initialDestination:query.destinationState, initialTaxpayer:query.taxpayer, initialOpportunity:search.get("oportunidade") || undefined, transferId:search.get("simulacao") || undefined}} />
}

export const metadata = { title: "Novo pedido de venda" }
