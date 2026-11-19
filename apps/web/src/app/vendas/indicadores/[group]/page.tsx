import { Suspense } from "react"
import { SalesIndicator } from "@/features/sales/sales-indicators"
export const metadata={title:"Indicador de vendas"}
type Params={params:Promise<{group:string}>}
export default function Page(props:Params) {
  return <Suspense fallback={<p role="status">Carregando indicador…</p>}><Resolved {...props}/></Suspense>
}
async function Resolved({params}:Params) {
  return <SalesIndicator group={(await params).group}/>
}
