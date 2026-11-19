/**
 * Parâmetros do módulo Serviços.
 *
 * O catálogo de parâmetros por empresa é do #302 (G5) e ainda não foi mesclado.
 * Até lá, os parâmetros ficam declarados só aqui, com o valor padrão usado pelo
 * código, para migrarem ao catálogo sem procurar constantes espalhadas.
 */
export const serviceParameters = {
  /** Dias de antecedência do alerta de fim de vigência de contrato. */
  "services.contracts.expiry_alert_days": { default: 30, min: 1, max: 365, description: "Antecedência do alerta de vencimento de contrato (dias)" },
  /** Dias de antecedência do alerta de reajuste pela data-base. */
  "services.contracts.adjustment_alert_days": { default: 30, min: 1, max: 365, description: "Antecedência do alerta de reajuste (dias)" },
  /** Prazo padrão de vencimento do título após a emissão, quando o contrato não informa. */
  "services.contracts.default_due_days": { default: 10, min: 0, max: 120, description: "Prazo padrão de vencimento do título do contrato (dias)" },
  /** Intervalo do job de faturamento recorrente. */
  "services.billing.interval_minutes": { default: 60, min: 5, max: 1440, description: "Intervalo do job de faturamento recorrente (minutos)" },
  /** Prazo de vencimento da cobrança gerada no fechamento de OS fora da garantia. */
  "services.orders.charge_due_days": { default: 10, min: 0, max: 120, description: "Prazo de vencimento da cobrança de OS (dias)" },
} as const

export type ServiceParameter = keyof typeof serviceParameters
export function parameter(name: ServiceParameter): number {
  return serviceParameters[name].default
}
