import { CollectionWorkspace } from "@/features/finance/collection-workspace"
import { Suspense } from "react"
type Props = { searchParams: Promise<{ groupId?: string; partyId?: string }> }
export default function Page(props: Props) {
  return (
    <Suspense fallback={<p role="status">Carregando cobranças…</p>}>
      <Workspace {...props} />
    </Suspense>
  )
}
async function Workspace({ searchParams }: Props) {
  const { groupId, partyId } = await searchParams
  return (
    <CollectionWorkspace
      groupId={typeof groupId === "string" ? groupId : ""}
      partyId={typeof partyId === "string" ? partyId : ""}
    />
  )
}

export const metadata = { title: "Remessas e retornos" }
