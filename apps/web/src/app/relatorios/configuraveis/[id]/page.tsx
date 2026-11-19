import { notFound } from "next/navigation"
import { SavedReportDetail } from "@/features/reports/engine/report-detail"

export default async function Page({ params }: PageProps<"/relatorios/configuraveis/[id]">) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  return <SavedReportDetail id={id.toLowerCase()} />
}

export const metadata = { title: "Relatório salvo" }
