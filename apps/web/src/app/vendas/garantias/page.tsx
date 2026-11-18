import { Suspense } from "react"
import { WarrantyList } from "@/features/sales/warranty-list"
export default function Page() { return <Suspense fallback={<p role="status">Carregando garantias…</p>}><WarrantyList/></Suspense> }

export const metadata = { title: "Garantias" }
