import { ReceivedMonitor } from "@/features/fiscal/received-monitor"

export default async function Page({searchParams}:{searchParams:Promise<{origem?:string}>}) {
  const {origem} = await searchParams
  return <ReceivedMonitor origin={origem === "vendas" ? "vendas" : "compras"} />
}

export const metadata = { title: "Notas fiscais de entrada" }
