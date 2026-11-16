import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { fixed } from "../sales/fixed.js"
import type { loadOrder } from "./snapshot.js"

export type OrderSnapshot = Awaited<ReturnType<typeof loadOrder>>
export function conflict(message: string): never { throw new Problem(409, "domain_conflict", message) }

export async function validateProducts(context: AuthorizedContext, order: OrderSnapshot) {
  for (const item of order.items) {
    const row = (await context.client.query("SELECT unit,status FROM products WHERE tenant_id=$1 AND id=$2", [context.tenantId, item.productId])).rows[0]
    if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
    if (row.unit !== item.unit) conflict("Unidade do produto mudou desde o rascunho. Cancele e recrie o pedido")
    if (row.status !== "active") conflict("O produto precisa estar ativo para esta operação")
  }
}

export async function validateCustomer(context: AuthorizedContext, order: OrderSnapshot) {
  const active = await context.client.query("SELECT EXISTS(SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active') AS active", [context.tenantId, order.data.customerId])
  if (!active.rows[0]?.active) conflict("O cliente precisa estar ativo para esta operação")
}

export async function validateAcceptance(context: AuthorizedContext, order: OrderSnapshot) {
  const { client, tenantId } = context, id = order.data.id
  await validateCustomer(context, order)
  const quote = (await client.query("SELECT approval_status FROM commercial_order_quotes WHERE tenant_id=$1 AND order_id=$2", [tenantId, id])).rows[0]
  if (quote && !["approved", "not_required"].includes(quote.approval_status as string)) conflict("Negociação precisa de aprovação antes de confirmar o pedido")
  if (!quote) {
    const simulated = (await client.query("SELECT EXISTS(SELECT 1 FROM order_pricing_snapshots WHERE tenant_id=$1 AND order_id=$2) AS present", [tenantId, id])).rows[0]?.present
    if (!simulated) {
      const bypass = await client.query("SELECT EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.tenant_id=o.tenant_id AND l.order_id=o.id JOIN price_table_items i ON i.tenant_id=l.tenant_id AND i.product_id=l.product_id JOIN commercial_settings s ON s.tenant_id=i.tenant_id AND s.active_price_version_id=i.version_id JOIN price_table_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id WHERE o.tenant_id=$1 AND o.id=$2 AND o.created_at>=v.published_at AND NOT EXISTS(SELECT 1 FROM sales_proposals sp WHERE sp.tenant_id=o.tenant_id AND sp.order_id=o.id AND sp.created_at<v.published_at)) AS bypass", [tenantId, id])
      if (bypass.rows[0]?.bypass) conflict("Tabela publicada exige negociação calculada. Recrie este rascunho no simulador comercial")
    }
  }
  const pending = await client.query("SELECT EXISTS(SELECT 1 FROM order_pricing_snapshots WHERE tenant_id=$1 AND order_id=$2 AND needs_approval AND approved_by IS NULL) AS pending", [tenantId, id])
  if (pending.rows[0]?.pending) conflict("A negociação exige aprovação da gestão antes da confirmação")
  const settings = (await client.query("SELECT minimum_order_amount_cents,maximum_payment_term_days,require_customer_contact FROM sales_settings WHERE tenant_id=$1", [tenantId])).rows[0]
  if (settings) {
    if (fixed(String(order.data.amount), 2) < BigInt(String(settings.minimum_order_amount_cents))) conflict("Pedido abaixo do valor mínimo configurado em Preferências / Vendas")
    const term = await client.query("SELECT $1::date <= (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + $2::integer AS valid", [order.data.dueDate, settings.maximum_payment_term_days])
    if (!term.rows[0]?.valid) conflict("Vencimento excede o prazo máximo configurado em Preferências / Vendas")
    if (settings.require_customer_contact) {
      const contact = await client.query("SELECT NULLIF(btrim(email),'') IS NOT NULL OR NULLIF(btrim(phone),'') IS NOT NULL AS present FROM parties WHERE tenant_id=$1 AND id=$2", [tenantId, order.data.customerId])
      if (!contact.rows[0]?.present) conflict("Preencha e-mail ou telefone no cadastro do cliente antes de confirmar o pedido")
    }
  }
  await validateProducts(context, order)
}
