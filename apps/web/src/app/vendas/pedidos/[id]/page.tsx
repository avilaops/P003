import Link from "next/link"
import { Suspense } from "react"
import { OrdersAccess } from "@/features/sales/orders-access"
type Props = { params: Promise<{ id: string }>; searchParams:Promise<{relatorio?:string|string[]}> }
export default function Page(props: Props) {
  return <Suspense fallback={<p role="status">Carregando pedido…</p>}><Resolved {...props} /></Suspense>
}
async function Resolved({ params,searchParams }:Props) {
  const source=(await searchParams).relatorio
  let back=""
  if(typeof source==="string"&&source.startsWith("/relatorios/vendas?")){
    const query=new URLSearchParams(source.slice(source.indexOf("?")+1)),allowed=["from","to","seller","channel","basis","view","origin","period"]
    back="/relatorios/vendas?"+new URLSearchParams([...query].filter(([key])=>allowed.includes(key)))
  }
  return <>{back&&<Link className="mx-4 text-primary underline" href={back}>Voltar ao relatório com os filtros</Link>}<OrdersAccess id={(await params).id}/></>
}

export const metadata = { title: "Detalhes de pedido de venda" }
