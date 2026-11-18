import { ReplenishmentPage } from "@/features/inventory/replenishment-access"

export const metadata = { title: "Detalhes de sugestão de compra" }

export default function Page({ params }: { params: Promise<{id:string}> }) {
  return <ReplenishmentPage params={params} />
}
