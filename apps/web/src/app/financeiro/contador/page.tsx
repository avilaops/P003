import {PageHeader} from "@/components/page-header"
import {AccountingWorkspace} from "@/features/finance/accounting-workspace"

export const metadata = {title:"Espaço do contador"}
export default function Page() {
  return <main className="workspace-page-frame space-y-5"><PageHeader eyebrow="Financeiro" title="Espaço do contador" description="Plano de contas, regras de contabilização e livros por competência."/><AccountingWorkspace/></main>
}
