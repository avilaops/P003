export function commercialRecordAction(kind: "pedidos" | "propostas", id: string, status: string, canEdit: boolean) {
  const editable = canEdit && status === "draft"
  return { href: `/vendas/${kind}/${id}${editable ? "/editar" : ""}`, label: editable ? "Continuar" : "Abrir" }
}

export function CommercialStatus({ status, label }: { status: string; label?: string }) {
  return <span className="inline-flex max-w-full items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium text-foreground">{label || (status === "draft" ? "Rascunho" : status)}</span>
}
