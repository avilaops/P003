import { Suspense } from "react"
import { NfeDraftEditor } from "@/features/fiscal/nfe-draft-editor"

type Props={params:Promise<{id:string}>;searchParams:Promise<{pedido?:string;lote?:string;ambiente?:string}>}
export default function Page(props:Props) {
  return <Suspense fallback={<p role="status">Carregando rascunho…</p>}><ResolvedDraft {...props} /></Suspense>
}

async function ResolvedDraft({ params, searchParams }:Props) {
  const { id } = await params
  const {pedido,lote,ambiente}=await searchParams
  return <NfeDraftEditor key={id} id={id} sourceOrderId={pedido} lotId={lote} lotEnvironment={ambiente==="homologation" ? "homologation" : "production"} />
}

export const metadata = { title: "Detalhes da NF-e" }
