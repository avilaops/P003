import { Suspense } from "react"
import { PosAccess } from "@/features/pos/pos-access"
export default function Page() {
  return (
    <Suspense fallback={<p role="status">Consultando o caixa…</p>}>
      <PosAccess view="closing" />
    </Suspense>
  )
}

export const metadata = { title: "Controle de caixa" }
