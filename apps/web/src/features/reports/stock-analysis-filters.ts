import { countLabels } from "../inventory/count-model.ts"

type SpecificFilter = { key: string; label: string; all: string; options: Record<string, string> }
const specificFilters: Record<string, SpecificFilter> = {
  stock_movement_activity: {
    key: "movementDirection", label: "Direção do movimento", all: "Entradas e saídas",
    options: { receipt: "Entrada", issue: "Saída" },
  },
  stock_count_progress: {
    key: "countStatus", label: "Situação do inventário", all: "Todas as situações", options: countLabels,
  },
  stock_production_progress: {
    key: "productionStatus", label: "Situação da ordem", all: "Todas as situações",
    options: { open: "Em andamento", ready: "Pronta", cancelled: "Cancelada" },
  },
}

export function specificFilter(dataset: string) {
  return Object.hasOwn(specificFilters, dataset) ? specificFilters[dataset] : undefined
}

export function tenantAnalysisParams(serialized: string, tenant: string) {
  const params = new URLSearchParams(serialized)
  const owner = params.get("tenant")
  const ids = ["productId", "warehouseId", "definitionId"]
  if (owner && owner !== tenant) {
    for (const key of [...ids, "offset"]) params.delete(key)
  }
  if (owner || ids.some(key => params.has(key))) params.set("tenant", tenant)
  return params
}

export function hasPeriod(source: string) {
  return ["stock_turnover", "stock_kardex", "stock_divergences", "stock_accuracy",
    "stock_movement_activity", "stock_count_progress", "stock_production_progress"].includes(source)
}

export function statusLabel(dataset: string, value: string) {
  if (dataset === "stock_position") {
    if (value === "active") return "Ativo"
    if (value === "archived") return "Arquivado"
  }
  const labels = specificFilter(dataset)?.options
  return labels && Object.hasOwn(labels, value) ? labels[value] : value
}

export function stockAnalysisQuery(params: Pick<URLSearchParams, "get">) {
  const definition = params.get("definitionId")
  const dataset = params.get("dataset") || (definition ? "" : "stock_position")
  const query = new URLSearchParams(definition ? { definitionId: definition } : { dataset })
  const keys = ["productId", "warehouseId"]
  if (hasPeriod(dataset)) keys.push("startDate")
  if (dataset && dataset !== "stock_position") keys.push("endDate")
  if (dataset === "stock_idle") keys.push("idleDays")
  const filter = specificFilter(dataset)
  if (filter) keys.push(filter.key)
  for (const key of keys) {
    const value = params.get(key)
    if (value) query.set(key, value)
  }
  return query
}

export function changeAnalysisFilters(currentSearch: string, tenant: string, changes: Record<string, string>, clear = false, resolvedDataset?: string) {
  const current = tenantAnalysisParams(currentSearch, tenant)
  const definition = current.get("definitionId")
  const dataset = definition && resolvedDataset ? resolvedDataset : current.get("dataset")
  const next = clear ? new URLSearchParams() : current
  if (dataset) next.set("dataset", dataset)
  if (definition) next.set("definitionId", definition)
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value)
    else next.delete(key)
  }
  const url = stockAnalysisQuery(next)
  const selectedDataset = next.get("dataset")
  if (next.has("definitionId") && selectedDataset) url.set("dataset", selectedDataset)
  url.set("tenant", tenant)
  if (changes.offset && changes.offset !== "0") url.set("offset", changes.offset)
  return url
}

export function reconcileDefinitionFilters(params: URLSearchParams, tenant: string, dataset: string) {
  const previous = params.get("dataset")
  const offset = previous && previous !== dataset ? "" : params.get("offset") ?? ""
  return changeAnalysisFilters(params.toString(), tenant, { offset }, false, dataset)
}
