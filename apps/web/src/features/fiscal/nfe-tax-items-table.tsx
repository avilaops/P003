"use client"

import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/workspace/data-table"
import { NfeItemFiscalReference } from "./nfe-financial-fields"
import type { DraftInput, DraftItem } from "./nfe-draft-model"

export function NfeTaxItemsTable({ draft, changeItem }: { draft: DraftInput; changeItem: (index: number, patch: Partial<DraftItem>) => void }) {
  const fields = [["ncm", "NCM", 8], ["cfop", "CFOP", 4], ["pisCst", "CST do PIS", 2], ["cofinsCst", "CST da COFINS", 2], ["icmsCst", "CST do ICMS", 2], ["csosn", "CSOSN", 3]] as const
  const label = (text: string, index: number) => index === 0 ? text : `${text} do item ${index + 1}`
  const field = (entry: typeof fields[number], item: DraftItem, index: number) => {
    const [key, title, max] = entry
    return <td className="p-1.5" key={key}><Input className="h-8 px-2 text-xs tabular-nums" aria-label={label(title, index)} required={key !== "icmsCst" && key !== "csosn"} maxLength={max} value={item[key] || ""} onChange={event => changeItem(index, { [key]: event.target.value || (key === "icmsCst" || key === "csosn" ? null : "") })} /></td>
  }
  return <>
    <div className="overflow-x-auto rounded-lg border" tabIndex={0} role="region" aria-label="Tabela de tributação dos itens">
      <DataTable className="w-full min-w-[820px] table-fixed text-xs">
        <caption className="sr-only">Tributação dos itens</caption>
        <colgroup>{["26%", "12%", "9%", "10%", "11%", "12%", "11%", "9%"].map((width, index) => <col key={index} style={{ width }} />)}</colgroup>
        <thead className="bg-muted/50"><tr>{["Item / Produto", "NCM", "CFOP", "CST do PIS", "CST da COFINS", "Origem da mercadoria", "CST do ICMS", "CSOSN"].map(title => <th scope="col" className="px-2 py-2 text-left font-medium" key={title}>{title.replace(" / ", " • ")}</th>)}</tr></thead>
        <tbody>{draft.items.map((item, index) => <tr key={index} className="border-t">
          <th scope="row" className="px-2 py-2 text-left font-normal"><span className="mr-2 text-muted-foreground">{index + 1}</span>{item.description || "Produto não informado"}</th>
          {fields.slice(0, 4).map(entry => field(entry, item, index))}
          <td className="p-1.5"><select required aria-label={label("Origem da mercadoria", index)} className="h-8 w-full rounded-md border bg-background px-2 text-xs" value={item.origin < 0 ? "" : item.origin} onChange={event => changeItem(index, { origin: event.target.value === "" ? -1 : Number(event.target.value) })}><option value="">Selecione</option>{[0,1,2,3,4,5,6,7,8].map(origin => <option key={origin} value={origin}>{origin}</option>)}</select></td>
          {fields.slice(4).map(entry => field(entry, item, index))}
        </tr>)}</tbody>
      </DataTable>
    </div>
    {draft.items.map((item, index) => <NfeItemFiscalReference key={index} draft={draft} item={item} index={index} change={patch => changeItem(index, patch)} />)}
  </>
}
