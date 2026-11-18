import assert from "node:assert/strict"
import test from "node:test"
import { stockAnalysisChart } from "../src/features/reports/stock-analysis-charts.ts"
import { changeAnalysisFilters, reconcileDefinitionFilters, stockAnalysisQuery, tenantAnalysisParams } from "../src/features/reports/stock-analysis-filters.ts"

function chart(dataset: string, data: Record<string, string | number | null>[], fields = Object.keys(data[0] ?? {})) {
  return stockAnalysisChart({ dataset, columns: fields.map(key => ({key, label: key})), data })
}

test("movimentos somam as seis casas por unidade e usam escalas independentes", () => {
  const result = chart("stock_movement_activity", [
    { unit: "KG", receipts: "9007199254.740991", issues: "0" },
    { unit: "UN", receipts: "3", issues: "5" },
    { unit: "KG", receipts: "0.000002", issues: "0.500000" },
  ])
  assert.deepEqual(result?.groups.map(group => [group.heading, ...group.bars.map(bar => bar.text)]),
    [["KG", "9.007.199.254,740993 KG", "0,5 KG"], ["UN", "3 UN", "5 UN"]])
  assert.equal(result?.groups[1].maximum, 5)
})

test("o progresso de um inventário vazio fica distinto de zero por cento contado", () => {
  const result = chart("stock_count_progress", [
    { reference: "A", progress: "0.00", lines: 10 },
    { reference: "B", progress: null, lines: 0 },
    { reference: "C", progress: "33.33", lines: 3 },
  ])
  assert.equal(result?.groups[0].maximum, 100)
  assert.deepEqual(result?.groups[0].bars.map(bar => [bar.value, bar.text]),
    [[0, "0%"], [null, "Sem linhas para contar"], [33.33, "33,33%"]])
})

test("etapas consolidam o número de ordens de cada SKU, independentemente da unidade", () => {
  const result = chart("stock_production_progress", [
    { stage: "Corte", unit: "M", orders: 2, quantity: "50" },
    { stage: "Corte", unit: "UN", orders: 1, quantity: "8" },
    { stage: "Acabamento", unit: "UN", orders: 5, quantity: "75" },
  ])
  assert.deepEqual(result?.groups[0].bars.map(bar => [bar.label, bar.value]), [["Corte", 3], ["Acabamento", 5]])
})

test("a classe ABC indeterminada e a acurácia sem contagens permanecem visíveis", () => {
  assert.deepEqual(chart("stock_abc", [{ class: "A" }, { class: "A" }, { class: null }])?.groups[0].bars.map(bar => bar.value), [2, 0, 0, 1])
  assert.equal(chart("stock_accuracy", [{ accuracy: null, lines: 0, matched: 0 }])?.groups[0].bars[0].text, "Sem linhas contadas")
})

test("definições com colunas incompatíveis e consultas vazias preservam a tabela sem gráfico", () => {
  assert.equal(chart("stock_count_progress", [{ reference: "INV1" }]), null)
  assert.equal(chart("stock_production_progress", []), null)
  assert.equal(chart("stock_movement_activity", [{ receipts: "1", issues: "2" }]), null)
})

test("o filtro ativo é partilhado pela consulta e exportação e descarta os de outras fontes", () => {
  const params = new URLSearchParams({dataset: "stock_count_progress", definitionId: "def", productId: "A", warehouseId: "B",
    countStatus: "open", productionStatus: "ready", movementDirection: "issue", idleDays: "20",
    startDate: "2026-11-01", endDate: "2026-11-18", offset: "25", tenant: "X"})
  assert.deepEqual(Object.fromEntries(stockAnalysisQuery(params)), { definitionId: "def", productId: "A", warehouseId: "B",
    countStatus: "open", startDate: "2026-11-01", endDate: "2026-11-18" })
  params.set("dataset", "stock_position")
  params.delete("definitionId")
  assert.deepEqual(Object.fromEntries(stockAnalysisQuery(params)), {dataset: "stock_position", productId: "A", warehouseId: "B"})
})

test("links de outra empresa perdem os identificadores antes da primeira consulta", () => {
  const link = "dataset=stock_count_progress&tenant=A&productId=SKU1&warehouseId=DEP&definitionId=DEF&offset=25&countStatus=open"
  assert.equal(tenantAnalysisParams(link, "A").get("productId"), "SKU1")
  assert.deepEqual(Object.fromEntries(tenantAnalysisParams(link, "B")), { dataset: "stock_count_progress", tenant: "B", countStatus: "open" })
  assert.equal(tenantAnalysisParams("definitionId=DEF", "B").get("tenant"), "B")
})

test("alterações consecutivas de produto e direção se acumulam na URL e reiniciam a paginação", () => {
  const location = new URL("https://erp.invalid/relatorios/estoque/analises?dataset=stock_movement_activity&offset=25")
  location.search = changeAnalysisFilters(location.search, "A", { productId: "SKU1" }).toString()
  location.search = changeAnalysisFilters(location.search, "A", { movementDirection: "issue" }).toString()
  assert.deepEqual(Object.fromEntries(location.searchParams), {
    dataset: "stock_movement_activity", productId: "SKU1", movementDirection: "issue", tenant: "A",
  })
  assert.deepEqual(Object.fromEntries(changeAnalysisFilters(location.search, "A", {}, true)),
    { dataset: "stock_movement_activity", tenant: "A" })
})

test("a fonte atual da definição substitui a fonte do link e conserva apenas filtros compatíveis", () => {
  const stale = new URLSearchParams("definitionId=DEF&dataset=stock_count_progress&countStatus=open&productId=SKU&startDate=2026-11-01&offset=25")
  const resolved = reconcileDefinitionFilters(stale, "A", "stock_production_progress")
  assert.deepEqual(Object.fromEntries(resolved), {
    definitionId: "DEF", dataset: "stock_production_progress", productId: "SKU", startDate: "2026-11-01", tenant: "A",
  })
  const selected = changeAnalysisFilters(stale.toString(), "A", {productionStatus: "ready"}, false, "stock_production_progress")
  assert.deepEqual(Object.fromEntries(stockAnalysisQuery(selected)), {
    definitionId: "DEF", productId: "SKU", startDate: "2026-11-01", productionStatus: "ready",
  })
  const position = reconcileDefinitionFilters(selected, "A", "stock_position")
  assert.deepEqual(Object.fromEntries(stockAnalysisQuery(position)), {definitionId: "DEF", productId: "SKU"})
  const unhinted = new URLSearchParams("definitionId=DEF&countStatus=open&productionStatus=ready")
  assert.deepEqual(Object.fromEntries(stockAnalysisQuery(unhinted)), {definitionId: "DEF"})
  assert.equal(reconcileDefinitionFilters(unhinted, "A", "stock_production_progress").get("productionStatus"), "ready")
})
