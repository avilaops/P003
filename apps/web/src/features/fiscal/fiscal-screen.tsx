import Link from "next/link"
import { OutgoingNfes } from "./outgoing-nfes"
import { PageHeader } from "@/components/page-header"

type Kind = "overview" | "nfce" | "guides"

const fiscalGroups = [
  {
    title: "Documentos recebidos",
    shortcuts: [
      ["Monitor fiscal e importação de XML", "/fiscal/monitor", "Consultar notas recebidas e importar XML"],
      ["CT-e recebidos", "/fiscal/ctes", "Consultar documentos de transporte"],
      ["NFS-e recebidas", "/fiscal/nfses", "Consultar notas de serviço"],
    ],
  },
  {
    title: "Documentos de saída",
    shortcuts: [
      ["NF-e", "/fiscal/notas-saida", "Preparar e consultar notas de saída"],
      ["NFC-e", "/fiscal/nfce", "Preparar e consultar documentos modelo 65"],
      ["NFS-e emitidas", "/fiscal/nfses/emitidas", "Consultar e enviar o XML da nota de serviço"],
    ],
  },
  {
    title: "Documentos auxiliares",
    shortcuts: [
      ["DANFE de XML autorizado", "/fiscal/danfe", "Gerar DANFE a partir do XML"],
    ],
  },
  {
    title: "Configuração e guias",
    shortcuts: [
      ["Configurações fiscais", "/preferencias/fiscal", "Configurar a empresa ativa"],
      ["Guias tributárias", "/fiscal/guias", "Indisponível"],
    ],
  },
] as const

export function FiscalScreen({ kind }: { kind: Kind }) {
  if (kind === "nfce") return <OutgoingNfes model={65} />
  if (kind === "guides") return <FiscalCapabilityUnavailable />
  return <FiscalOverview />
}

export function FiscalCapabilityUnavailable() {
  return (
    <Shell title="Guias tributárias" description="GNRE, DARE-SP e DAS ainda não possuem cálculo, emissão ou persistência fiscal neste ERP." back="/fiscal">
      <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6">
        <h2 className="text-lg font-semibold">Integração fiscal pendente</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Esta capacidade permanece indisponível até existir contrato de backend,
          regras por tributo e UF, permissões, cálculo verificável e integração
          oficial. Nenhuma guia será calculada, emitida ou marcada como paga por
          esta tela.
        </p>
      </section>
    </Shell>
  )
}

function FiscalOverview() {
  return (
    <Shell title="Fiscal" description="Configurações e documentos fiscais da empresa ativa.">
      <nav className="grid items-start gap-4 lg:grid-cols-2" aria-label="Áreas fiscais">
        {fiscalGroups.map(({ title, shortcuts }) => (
          <section key={title} className="rounded-lg border bg-card">
            <h2 className="border-b px-3 py-2 text-sm font-semibold">{title}</h2>
            <ul className="divide-y">
              {shortcuts.map(([label, href, description]) => (
                <li key={href}>
                  <Link
                    className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
                    href={href}
                  >
                    <span className="font-medium">{label}</span>
                    <span className="text-muted-foreground">{description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </Shell>
  )
}

function Shell({
  title,
  description,
  back,
  children,
}: {
  title: string
  description: string
  back?: string
  children: React.ReactNode
}) {
  return (
    <div className="workspace-page-frame">
      {back && <Link className="mb-5 inline-flex text-sm text-muted-foreground hover:text-foreground" href={back}>← Fiscal</Link>}
      <PageHeader eyebrow="Fiscal" title={title} description={description} />
      <div className="mt-7">{children}</div>
    </div>
  )
}
