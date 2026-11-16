import { createHash } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { approvalRulesSchema } from "./approvals.js"
import { calculateNegotiation, type NegotiationInput, type SourceItem } from "./negotiation-model.js"
import { parametersSchema } from "./parameters.js"

export const sourceColumns = "i.product_id,i.product_snapshot->>'sku' AS sku,i.product_snapshot->>'name' AS name,i.product_snapshot->>'unit' AS unit,p.price_revision AS product_revision,i.cost_revision,i.price_without_ipi_cents AS price_cents,(i.cost_snapshot->>'purchaseCostCents')::bigint AS purchase_cents,(i.cost_snapshot->>'taxCreditBps')::integer AS credit_bps,(i.cost_snapshot->>'packagingCents')::bigint AS packaging_cents"
export const sourceJoins = "FROM price_table_items i JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id JOIN price_table_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id LEFT JOIN product_costs c ON c.tenant_id=i.tenant_id AND c.product_id=i.product_id"
export const sourceAvailable = "p.status='active' AND p.unit=i.product_snapshot->>'unit' AND p.price_revision=(i.product_snapshot->>'revision')::bigint AND ((v.source_kind='calculated' AND c.product_line=$4 AND c.revision=i.cost_revision) OR (v.source_kind='legacy' AND i.cost_revision IS NULL AND i.source_snapshot->>'source'=v.source_reference->>'source'))"
export function sourceItem(row: Record<string, unknown>): SourceItem {
  for (const name of ["product_id", "sku", "name", "unit", "product_revision", "price_cents", "purchase_cents", "credit_bps", "packaging_cents"]) if (row[name] == null) throw new Problem(500, "internal_error", "Erro interno")
  return { productId: String(row.product_id), sku: String(row.sku), name: String(row.name), unit: String(row.unit), productRevision: revisionValue(row.product_revision), costRevision: row.cost_revision === null ? null : revisionValue(row.cost_revision), priceCents: revisionValue(row.price_cents), purchaseCents: revisionValue(row.purchase_cents), creditBps: Number(row.credit_bps), packagingCents: revisionValue(row.packaging_cents) }
}
export async function loadApprovalRules(context: AuthorizedContext) {
  const row = (await context.client.query("SELECT revision,rules FROM commercial_approval_settings WHERE tenant_id=$1", [context.tenantId])).rows[0]
  if (!row) throw new Problem(409, "domain_conflict", "Salve as regras de aprovação da empresa antes de simular")
  const parsed = approvalRulesSchema.safeParse(row.rules)
  if (!parsed.success) throw new Problem(500, "internal_error", "Erro interno")
  return { revision: revisionValue(row.revision), rules: parsed.data }
}
export async function prepareNegotiation(context: AuthorizedContext, input: NegotiationInput) {
  if (!["imported", "national"].includes(input.line)) throw new Problem(422, "invalid_input", "Linha comercial inválida")
  const row = (await context.client.query("SELECT v.version,v.settings_revision,s.revision,v.policy_snapshot FROM commercial_settings s JOIN price_table_versions v ON v.tenant_id=s.tenant_id AND v.id=s.active_price_version_id WHERE s.tenant_id=$1 AND s.product_line=$2 AND v.id=$3", [context.tenantId, input.line, input.versionId])).rows[0]
  if (!row) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
  if (revisionValue(row.settings_revision) !== revisionValue(row.revision)) throw new Problem(409, "domain_conflict", "Parâmetros alterados após a publicação. Publique a tabela atualizada antes de simular")
  const parameters = parametersSchema.safeParse(row.policy_snapshot)
  if (!parameters.success) throw new Problem(500, "internal_error", "Erro interno")
  const { revision: rulesRevision, rules } = await loadApprovalRules(context)
  if (!input.items.length || input.items.length > 100) throw new Problem(422, "invalid_input", "Simulação exige de 1 a 100 equipamentos")
  const sources = []
  for (const item of input.items) {
    const source = (await context.client.query(`SELECT ${sourceColumns} ${sourceJoins} WHERE i.tenant_id=$1 AND i.version_id=$2 AND i.product_id=$3 AND v.product_line=$4 AND ${sourceAvailable}`, [context.tenantId, input.versionId, item.productId, input.line])).rows[0]
    if (!source) throw new Problem(409, "domain_conflict", "Produto ou custo alterado, indisponível ou fora da tabela. Atualize e publique a tabela")
    sources.push(sourceItem(source))
  }
  const { sale, director } = calculateNegotiation(parameters.data, rules, input, sources)
  const raw = { tenantId: context.tenantId, input, rulesRevision, rules, policy: row.policy_snapshot, sources, sale, director }
  return { kind: "single" as const, sale, director, rules, policy: row.policy_snapshot, sources, digest: createHash("sha256").update(canonicalJson(raw)).digest("hex"), version: revisionValue(row.version) }
}
