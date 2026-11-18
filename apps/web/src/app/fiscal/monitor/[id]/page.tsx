import { Suspense } from "react"
import { ReceivedDocumentDetail } from "@/features/fiscal/received-document-detail"

async function ResolvedPage({ params,searchParams }: { params: Promise<{ id: string }>; searchParams:Promise<{origem?:string}> }) {
  const [{id},{origem}] = await Promise.all([params,searchParams])
  return <ReceivedDocumentDetail id={id} origin={origem==="compras" || origem==="vendas" ? origem : "fiscal"}/>
}

export const metadata = { title: "Documento fiscal recebido" }

export default function Page(props: Parameters<typeof ResolvedPage>[0]) {
  return <Suspense fallback={<p role="status" className="p-6">Carregando tela…</p>}><ResolvedPage {...props} /></Suspense>
}
