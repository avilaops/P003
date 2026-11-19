/**
 * Parâmetros do módulo Meu Negócio (G1/G2).
 *
 * O catálogo de parâmetros por empresa é do #302 (G5). Enquanto ele não existe,
 * os parâmetros do módulo ficam declarados só aqui, com o formato que o catálogo
 * vai pedir, para migrar de uma vez. Nenhum outro arquivo define estes valores.
 */
export type ModuleParameter<T> = { key: string; module: string; label: string; description: string; default: T }

export const pendingWorkParameters = {
  /** Usado também pela lista de propostas (`validity=expiring`), para o total bater. */
  expiringProposalDays: { key: "pending.proposals.expiring_days", module: "meu-negocio", label: "Propostas vencendo (dias)", description: "Propostas enviadas que vencem em até este número de dias entram no painel de pendências.", default: 3 },
  certificateWarningDays: { key: "pending.fiscal.certificate_warning_days", module: "meu-negocio", label: "Aviso de certificado (dias)", description: "O certificado digital entra no painel de pendências quando vence em até este número de dias.", default: 30 },
} satisfies Record<string, ModuleParameter<number>>

export const expiringProposalDays = pendingWorkParameters.expiringProposalDays.default
export const certificateWarningDays = pendingWorkParameters.certificateWarningDays.default
