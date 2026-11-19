import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"

export const paymentTermLimitMessage = "Vencimento excede o prazo máximo configurado em Preferências / Vendas"

/**
 * Prazo máximo de pagamento de Preferências / Vendas, aplicado ao salvar e ao confirmar o pedido.
 * A referência é a data de hoje em Brasília; sem configuração de vendas não há limite.
 */
export async function assertPaymentTermLimit(context: AuthorizedContext, dueDate: string) {
  const { rows } = await context.client.query<{ valid: boolean }>(
    "SELECT $2::date <= (statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date + s.maximum_payment_term_days AS valid FROM sales_settings s WHERE s.tenant_id=$1",
    [context.tenantId, dueDate],
  )
  if (rows[0] && !rows[0].valid) throw new Problem(409, "domain_conflict", paymentTermLimitMessage)
}
