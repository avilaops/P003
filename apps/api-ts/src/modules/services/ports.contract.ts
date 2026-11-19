import type { TenantContext } from "../../platform/database.js"

/**
 * Interfaces mínimas que o módulo Serviços consome de outros PRs.
 *
 * - `ServiceInvoicePort`: emissão de NFS-e de saída — dono #298 (Fiscal F6).
 * - `ReceivablePort`: título a receber avulso (sem pedido) — dono #297 (Financeiro FI1).
 *
 * Enquanto as implementações não forem mescladas, `AppDependencies.services`
 * fica sem portas e o faturamento registra o período como `pending`
 * ("aguardando integração"). O job repete o período sozinho quando a porta
 * passar a existir; nada é gerado em dobro porque cada chamada leva a chave
 * idempotente do período (ou da OS).
 *
 * As portas recebem a transação da empresa (`TenantContext`): o título deve
 * ser gravado na mesma transação. A NFS-e deve ser enfileirada pelo F6 (não
 * bloquear a transação esperando a prefeitura) e devolver a referência local.
 */
export type PortResult =
  | { status: "issued"; reference: string }
  /** Regra incompleta (ex.: tributação sem cadastro): o ERP não inventa, bloqueia com mensagem. */
  | { status: "blocked"; message: string }

export type ServiceInvoiceItem = { description: string; serviceCode: string; quantity: string; unitCents: number; amountCents: number }
export type ServiceInvoiceRequest = {
  idempotencyKey: string
  customerId: string
  issueOn: string
  competence: { start: string; end: string }
  items: ServiceInvoiceItem[]
  amountCents: number
  description: string
  origin: { type: "service_contract_billing"; id: string; contractId: string }
}
export interface ServiceInvoicePort {
  issue(ctx: TenantContext, request: ServiceInvoiceRequest): Promise<PortResult>
}

export type ReceivableRequest = {
  idempotencyKey: string
  customerId: string
  amountCents: number
  issueOn: string
  dueOn: string
  description: string
  origin: { type: "service_contract_billing" | "service_order"; id: string }
}
export interface ReceivablePort {
  open(ctx: TenantContext, request: ReceivableRequest): Promise<PortResult>
}

export type ServicePorts = { invoices?: ServiceInvoicePort; receivables?: ReceivablePort }
