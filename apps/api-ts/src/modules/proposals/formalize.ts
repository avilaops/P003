import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { prepareMixed } from "../commercial/mixed-prepare.js"
import type { MixedInput } from "../commercial/mixed-model.js"
import { saveCheckout, type CheckoutInput } from "../orders/checkout-save.js"
import { sameSnapshot } from "./commercial.js"
import { customerSnapshotSql, validateFiscalCustomer } from "../sales/customer-fiscal.js"

function conflict(message: string): never { throw new Problem(409, "domain_conflict", message) }
type Prepared = Awaited<ReturnType<typeof prepareMixed>>
type Public = { kind: string; input: MixedInput; digest: string; sale: Prepared["sale"] }
type Approval = { by: string; digest: string }
type Agreement = { commercial_public: Public | null; commercial_approval: Approval | null; customer_snapshot: Record<string, unknown> | null; checkout_snapshot: CheckoutInput | null; customer_id: string }

export async function formalizeProposal(context: AuthorizedContext, id: string, version: number) {
  const { client, tenantId } = context
  const agreement = (await client.query<Agreement>("SELECT commercial_public,commercial_approval,customer_snapshot,checkout_snapshot,customer_id FROM sales_proposal_versions WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version])).rows[0]!
  if (!agreement.commercial_public) {
    const published = (await client.query("SELECT EXISTS(SELECT 1 FROM sales_proposal_lines l JOIN price_table_items i ON i.tenant_id=l.tenant_id AND i.product_id=l.product_id JOIN commercial_settings s ON s.tenant_id=i.tenant_id AND s.active_price_version_id=i.version_id WHERE l.tenant_id=$1 AND l.proposal_id=$2 AND l.version=$3) AS present", [tenantId, id, version])).rows[0]?.present
    if (published) conflict("Revise esta proposta com a cotação comercial antes de enviar, aprovar ou converter")
    return null
  }
  const quote = agreement.commercial_public
  const prepared = await prepareMixed(context, quote.input)
  if (prepared.digest !== quote.digest) conflict("A tabela, os custos ou as regras mudaram. Revise a cotação antes de formalizar")
  const customer = (await client.query<{ data: Record<string, unknown> }>(customerSnapshotSql, [tenantId, agreement.customer_id])).rows[0]?.data
  if (!customer || !sameSnapshot(customer, agreement.customer_snapshot)) conflict("O cadastro do cliente mudou. Revise a proposta antes de formalizar")
  validateFiscalCustomer(customer, quote.input)
  let approval = agreement.commercial_approval
  if (prepared.sale.approvalReasons.length && approval?.digest !== quote.digest) {
    const director = context.permissions.includes("sales.approvals.director")
    const manager = context.permissions.includes("sales.approvals.manage") && !prepared.director.requiresDirector
    if (!director && !manager) conflict("A negociação está acima da sua alçada. A gestão precisa aprovar esta proposta antes do envio ou conversão")
    approval = { by: context.authSubject, digest: quote.digest }
    await client.query("UPDATE sales_proposal_versions SET commercial_approval=$4 WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, approval])
  }
  return { agreement, quote, prepared, approval }
}

export async function transferProposalAgreement(context: AuthorizedContext, order: string, checked: NonNullable<Awaited<ReturnType<typeof formalizeProposal>>>) {
  const { client, tenantId } = context, { prepared, quote, approval, agreement } = checked
  const status = prepared.sale.approvalReasons.length ? "approved" : "not_required"
  await client.query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) SELECT $1,$2,NULL,$3,$4,$5,$6,$7,id FROM identities WHERE auth_subject=$8", [tenantId, order, quote, { director: prepared.director, policies: prepared.policies, sources: prepared.sources }, prepared.rules, status, prepared.director.requiresDirector, context.authSubject])
  for (const policy of prepared.policies) await client.query("INSERT INTO commercial_order_quote_versions(tenant_id,order_id,product_line,version_id,version_snapshot) VALUES($1,$2,$3,$4,$5)", [tenantId, order, policy.line, policy.versionId, policy])
  if (status === "approved" && approval) await client.query("INSERT INTO commercial_approval_decisions(id,tenant_id,order_id,order_revision,decision,reason,decided_by) SELECT $1,$2,$3,1,'approved','Aprovação registrada na proposta comercial',id FROM identities WHERE auth_subject=$4", [randomUUID(), tenantId, order, approval.by])
  if (agreement.checkout_snapshot) await saveCheckout(context, order, agreement.customer_id, BigInt(prepared.sale.totalCents), BigInt(prepared.sale.downPaymentCents), agreement.checkout_snapshot)
}
