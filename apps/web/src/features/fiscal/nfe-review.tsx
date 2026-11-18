"use client"

import { Button } from "@/components/ui/button"
import { itemTotal, type DraftInput } from "./nfe-draft-model"

type Issue = { step: number; label: string; message: string }
export function draftIssues(draft: DraftInput): Issue[] {
  const issues: Issue[] = []
  if (!draft.operationNature.trim()) issues.push({ step: 0, label: "Natureza da operação", message: "Informe a natureza da operação." })
  if (!draft.recipient.legalName.trim()) issues.push({ step: 1, label: draft.recipient.state === "EX" ? "Nome do destinatário" : "Nome ou razão social", message: "Identifique o destinatário." })
  if (draft.recipient.state !== "EX" && !/^\d{11}$|^\d{14}$/.test(draft.recipient.taxId)) issues.push({ step: 1, label: "CPF/CNPJ", message: "Confira o CPF/CNPJ do destinatário." })
  draft.items.forEach((item, index) => {
    const label = (name: string) => index ? `${name} do item ${index + 1}` : name
    const add = (name: string, message: string, step = 3) => issues.push({ step, label: label(name), message: `Item ${index + 1} • ${message}` })
    if (!item.description.trim()) add("Descrição do produto", "informe o produto.", 2)
    try { if (Number(itemTotal(item.quantity, item.unitPrice)) <= 0) add("Preço unitário", "confira quantidade e preço.", 2) } catch { add("Preço unitário", "confira quantidade e preço.", 2) }
    for (const [key, name, size] of [["ncm", "NCM", 8], ["cfop", "CFOP", 4], ["pisCst", "CST do PIS", 2], ["cofinsCst", "CST da COFINS", 2]] as const) if (!new RegExp(`^\\d{${size}}$`).test(item[key])) add(name, `confira ${name}.`)
    if (item.origin < 0) add("Origem da mercadoria", "selecione a origem.")
    if (!!item.icmsCst === !!item.csosn) add("CST do ICMS", "informe CST do ICMS ou CSOSN conforme o regime.")
  })
  return issues
}

export function NfeReview({ draft, navigate }: { draft: DraftInput; navigate: (step: number, label?: string) => void }) {
  const issues = draftIssues(draft)
  return <div className="space-y-3">
    <p className="rounded-lg border p-3 text-sm"><strong>Origem da nota • </strong>{draft.sourceOrderId ? `Pedido vinculado ${draft.sourceOrderId}` : draft.sourceReturnId ? `Devolução vinculada ${draft.sourceReturnId}` : "Preenchimento avulso • sem pedido vinculado"}</p>
    <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-xs"><caption className="sr-only">Produtos na revisão da nota</caption><thead className="bg-muted/50"><tr>{["Produto", "Quantidade", "Preço unitário", "Total dos produtos"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>{draft.items.map((item, index) => <tr className="border-t" key={index}><td className="p-2">{index + 1} • {item.description || "Não informado"}</td><td className="p-2">{item.quantity}</td><td className="p-2">{item.unitPrice}</td><td className="p-2">{(() => { try { return `R$ ${itemTotal(item.quantity, item.unitPrice).replace(".", ",")}` } catch { return "Pendente" } })()}</td></tr>)}</tbody></table></div>
    {!!issues.length && <section aria-label="Pendências do preenchimento" className="rounded-lg border p-3"><h3 className="text-sm font-semibold">Confira antes de salvar</h3><ul className="mt-2 space-y-1">{issues.map((issue, index) => <li key={index} className="flex items-center justify-between gap-2 text-xs"><span>{issue.message}</span><Button type="button" variant="outline" size="sm" onClick={() => navigate(issue.step, issue.label)}>Corrigir • {issue.label}</Button></li>)}</ul></section>}
    <p className="text-xs text-muted-foreground">A conferência completa continua ao salvar e na validação fiscal da emissão.</p>
  </div>
}
