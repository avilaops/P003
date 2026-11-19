import Link from "next/link"

/** Atalho compacto das telas de área para o motor de relatórios com a fonte da área. */
export function EngineShortcut({ source, label }: { source: string; label: string }) {
  return <p className="workspace-page-frame -mb-2 flex flex-wrap items-center gap-2 pt-3 text-xs text-muted-foreground">
    <span>Precisa de outro recorte?</span>
    <Link className="font-medium text-primary underline" href={`/relatorios/configuraveis?fonte=${source}`}>{label}: escolher colunas, totais, exportar e agendar por e-mail</Link>
  </p>
}
