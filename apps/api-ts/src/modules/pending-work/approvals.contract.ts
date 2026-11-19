import type { AuthorizedContext } from "../../platform/access.js"

/**
 * Contrato mínimo com o motor de aprovação por alçada (#296, item C3).
 *
 * O painel de pendências não cria aprovações: só conta as filas que o motor
 * expõe. Quando #296 entrar, ele registra a fila de Compras (e as demais) em
 * `approvalQueues` e o painel passa a exibi-las sem outra mudança aqui.
 * Vendas (V1) já tem fila própria (`commercial/reviews.ts`) e é lida direto.
 */
export type ApprovalQueue = {
  key: string
  title: string
  /** Basta uma destas permissões para ver a fila. */
  permissions: readonly string[]
  /** Lista que mostra exatamente as mesmas solicitações contadas. */
  href: string
  pending(context: AuthorizedContext): Promise<{ count: number; amountCents: bigint }>
}

export const approvalQueues: ApprovalQueue[] = []
