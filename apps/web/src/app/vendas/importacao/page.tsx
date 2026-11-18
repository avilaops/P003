import { Suspense } from "react"
import { OrderImport } from "@/features/sales/imports/order-import"

export default function Page() {
  return <Suspense fallback={<p role="status">Carregando importação…</p>}><OrderImport /></Suspense>
}
export const metadata = { title: "Importar pedidos" }
