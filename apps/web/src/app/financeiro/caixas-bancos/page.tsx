import { FinancialAccountLedger } from "@/features/finance/financial-account-ledger"
import { Suspense } from "react"
type Props = { searchParams: Promise<{ accountId?: string }> }
export default function Page(props: Props) {
  return (
    <Suspense fallback={<p role="status">Carregando contas…</p>}>
      <Workspace {...props} />
    </Suspense>
  )
}
async function Workspace({ searchParams }: Props) {
  const { accountId } = await searchParams
  return (
    <FinancialAccountLedger
      initialAccountId={
        typeof accountId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountId)
          ? accountId.toLowerCase()
          : ""
      }
    />
  )
}

export const metadata = { title: "Caixas e bancos" }
