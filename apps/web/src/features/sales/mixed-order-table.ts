import type { PriceTable } from "./negotiation-types"

/** Presentation only • simulation receives the real source version on every item. */
export function mixedOrderTable(tables: PriceTable[], tenantId: string, warnings: string[] = []): PriceTable {
  if (!tables.length || tables.some(table => table.tenantId !== tenantId)) throw new Error("As tabelas não correspondem à empresa ativa.")
  const published = tables.filter(table => table.data)
  const origins = [...new Set(published.map(table => table.data!.originState))]
  const minimum = (values: number[]) => values.length ? Math.min(...values) : 0
  return {
    tenantId, line: "mixed", sources: tables, sourceWarnings: warnings,
    canManage: tables.every(table => table.canManage),
    canCreateOrder: published.length > 0 && published.every(table => table.canCreateOrder !== false),
    authority: published.every(table => table.authority === published[0]?.authority) ? published[0]?.authority : "seller",
    paymentMethods: published[0]?.paymentMethods,
    data: !published.length ? null : {
      id: published.map(table => `${table.line}:${table.data!.id}`).sort().join(","),
      version: 0, publishedAt: "", originState: origins.length === 1 ? origins[0] : "",
      freeDiscountBps: minimum(published.map(table => table.data!.freeDiscountBps)),
      minimumDownPaymentBps: minimum(published.map(table => table.data!.minimumDownPaymentBps)),
      items: published.flatMap(table => table.data!.items.map(item => ({ ...item, line: table.line, versionId: table.data!.id, tableVersion: table.data!.version }))),
    },
  }
}
