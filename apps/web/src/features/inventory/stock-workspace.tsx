"use client"

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Pagination } from "@/components/workspace/pagination"
import { DataTable } from "@/components/workspace/data-table"
import { SearchInput } from "@/components/search-input"
import { useResource } from "@/hooks/use-operation"
import { commercialQuantity } from "@/features/sales/order-presentation"
import { StockHistory } from "./stock-history"
import { historyPath, manualPath, pageOffset, pageSize, stockUrl, textLink, type StockList } from "./stock-model"

export function StockWorkspace({ tenant, path: pathname }: { tenant: string; path: string }) {
  const search = useSearchParams(), router = useRouter()
  const owner = search.get("tenant")
  const outdated = Boolean(owner && owner !== tenant)
  const productId = search.get("productId")
  useEffect(() => {
    if (outdated) router.replace(pathname)
    else if (productId && !owner) {
      const next = new URLSearchParams(search)
      next.set("tenant", tenant)
      window.history.replaceState(null, "", pathname + "?" + next)
    }
  }, [outdated, owner, pathname, productId, router, search, tenant])
  if (outdated) return <p role="status">Carregando o estoque da empresa ativa…</p>
  if ((pathname === historyPath || pathname === manualPath) && productId)
    return <StockHistory key={productId} productId={productId} tenant={tenant} manual={pathname === manualPath} />
  return <StockGrid tenant={tenant} path={pathname} />
}

function StockGrid({ tenant, path }: { tenant: string; path: string }) {
  const search = useSearchParams()
  const q = search.get("q") || "", offset = pageOffset(search.get("offset"))
  const focus = search.get("focus")
  const list = useResource<StockList>(stockUrl("/api/erp/stock", { q, offset, limit: pageSize }))
  const stocks = list.value?.tenantId === tenant ? list.value : null
  useEffect(() => {
    if (stocks && focus) document.getElementById("stock-" + focus)?.focus()
  }, [stocks, focus])
  function setQuery(q: string, offset: number) {
    window.history.replaceState(null, "", stockUrl(path, { tenant, q, offset }))
  }
  const manual = path === manualPath
  const title = manual ? "Novo lançamento de estoque" : path === historyPath ? "Lançamentos de estoque" : "Saldos de estoque"
  return <div className="workspace-page-frame">
    <PageHeader title={title} actions={<Link href="/cadastros/produtos" className={textLink}>Consultar catálogo</Link>} />
    <section className="form-section min-w-0 space-y-4" aria-label="Consulta de saldos">
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault()
        setQuery(String(new FormData(event.currentTarget).get("q") || "").trim(), 0)
      }}>
        <label className="min-w-0 flex-1">Buscar produto ou SKU<SearchInput name="q" maxLength={160} defaultValue={q} onSearch={value => setQuery(value.trim(), 0)} /></label>
        <Button type="submit" variant="outline">Buscar</Button>
      </form>
      {list.loading ? <p role="status">Carregando saldos…</p> : !stocks ?
        <div role="alert"><p>{list.error || "A empresa da sessão mudou. Atualize a consulta."}</p><Button variant="outline" onClick={list.reload}>Tentar novamente</Button></div> : <>
        <p className="text-sm text-muted-foreground">{stocks.total} produto(s) • {stocks.canEdit ? "Consulta e movimentação" : "Somente consulta"}</p>
        {stocks.data.length ? <DataTable aria-label="Saldos por produto" className="table-fixed [&_td]:px-2 [&_th]:px-2">
          <thead><tr><th className="w-[56%] lg:w-[25%]" scope="col">Produto</th><th className="hidden lg:table-cell" scope="col">SKU</th>
            <th className="hidden w-[7%] lg:table-cell" scope="col">Unidade</th>
            {["Saldo", "Reservado", "Disponível"].map(label => <th key={label} className="hidden text-right lg:table-cell" scope="col">{label}</th>)}
            <th scope="col" className="lg:w-[17%]"><span className="lg:sr-only">Quantidades e ação</span></th></tr></thead>
          <tbody>{stocks.data.map(stock => {
            const href = stockUrl(manual && stocks.canEdit ? manualPath : historyPath, { productId: stock.productId, sku: stock.sku, tenant, from: path, q, offset })
            return <tr key={stock.productId} className="[overflow-wrap:anywhere]"><th scope="row" className="align-top">
              <span className="block font-medium">{stock.name}</span><span className="block text-xs font-normal text-muted-foreground">{stock.status === "active" ? "Ativo" : "Arquivado"}</span>
              <span className="mt-1 block text-sm font-normal lg:hidden">SKU {stock.sku}<br />Unidade {stock.unit}</span></th>
              <td className="hidden lg:table-cell">{stock.sku}</td><td className="hidden lg:table-cell">{stock.unit}</td>
              {[stock.quantity, stock.reserved, stock.available].map((value, i) => <td key={i} className="hidden text-right tabular-nums lg:table-cell">{commercialQuantity(value)}</td>)}
              <td className="align-top"><dl className="text-sm tabular-nums lg:hidden">
                {([["Saldo", stock.quantity], ["Reservado", stock.reserved], ["Disponível", stock.available]] as const).map(([label, amount]) =>
                  <div key={label} className="flex flex-wrap justify-between gap-x-1"><dt>{label}</dt><dd>{commercialQuantity(amount)}</dd></div>)}
              </dl><Link id={"stock-" + stock.productId} className={textLink} href={href}
                aria-label={`${manual && stocks.canEdit ? "Lançar movimento" : "Ver movimentos"} de ${stock.name} • SKU ${stock.sku}`}
                onNavigate={() => window.history.replaceState(null, "", stockUrl(path, { tenant, q, offset, focus: stock.productId }))}>
                {manual && stocks.canEdit ? "Lançar movimento" : "Ver movimentos"}</Link></td></tr>
          })}</tbody>
        </DataTable> : <p>{stocks.total ? "Nenhum produto nesta página." : "Nenhum produto encontrado."}</p>}
        <Pagination offset={offset} total={stocks.total} pageSize={pageSize} maxOffset={100000} onOffsetChange={value => setQuery(q, value)} />
      </>}
      <Link className={textLink} href="/cadastros/produtos/novo" target="_blank" rel="noopener noreferrer">Cadastrar produto</Link>
    </section>
  </div>
}
