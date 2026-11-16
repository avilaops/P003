import { createHash } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { calculateMixed, type MixedInput, type Policy } from "./mixed-model.js"
import { parametersSchema } from "./parameters.js"
import { loadApprovalRules, sourceAvailable, sourceColumns, sourceItem, sourceJoins } from "./prepare.js"

export async function prepareMixed(context: AuthorizedContext, input: MixedInput) {
  if (!input.items.length || input.items.length > 100) throw new Problem(422, "invalid_input", "Simulação exige de 1 a 100 equipamentos")
  const policies: Policy[] = [], sources = []
  for (const item of input.items) {
    if (!["imported", "national"].includes(item.line)) throw new Problem(422, "invalid_input", "Linha comercial inválida")
    if (!policies.some(policy => policy.line === item.line && policy.versionId === item.versionId)) {
      const row = (await context.client.query("SELECT v.version,v.settings_revision,s.revision,v.policy_snapshot FROM commercial_settings s JOIN price_table_versions v ON v.tenant_id=s.tenant_id AND v.id=s.active_price_version_id WHERE s.tenant_id=$1 AND s.product_line=$2 AND v.product_line=$2 AND v.id=$3", [context.tenantId, item.line, item.versionId])).rows[0]
      if (!row) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if (revisionValue(row.settings_revision) !== revisionValue(row.revision)) throw new Problem(409, "domain_conflict", "Parâmetros alterados após a publicação. Publique a tabela atualizada antes de simular")
      const parsed = parametersSchema.safeParse(row.policy_snapshot)
      if (!parsed.success) throw new Problem(500, "internal_error", "Erro interno")
      policies.push({ line: item.line, versionId: item.versionId, version: revisionValue(row.version), parameters: parsed.data })
    }
    const row = (await context.client.query(`SELECT ${sourceColumns} ${sourceJoins} WHERE i.tenant_id=$1 AND i.version_id=$2 AND i.product_id=$3 AND v.product_line=$4 AND ${sourceAvailable}`, [context.tenantId, item.versionId, item.productId, item.line])).rows[0]
    if (!row) throw new Problem(409, "domain_conflict", "Produto ou custo alterado, indisponível ou fora da tabela. Atualize e publique a tabela")
    sources.push(sourceItem(row))
  }
  const { revision: rulesRevision, rules } = await loadApprovalRules(context), { sale, director } = calculateMixed(input, policies, sources, rules)
  const raw = { tenantId: context.tenantId, input, rulesRevision, rules, policies, sources, sale, director }
  return { kind: "mixed" as const, sale, director, rules, policies, sources, digest: createHash("sha256").update(canonicalJson(raw)).digest("hex") }
}
