import type { FastifyInstance } from "fastify"

import type { AccessDependencies } from "../../platform/access.js"
import { assistantFromEnv } from "./assistant-ollama.js"
import type { AssistantProvider } from "./assistant-provider.js"
import { registerAssistantRoute } from "./assistant.js"
import { docusealFromEnv, registerContractWebhook, type ContractProvider } from "./contract-webhook.js"
import { mercadoPagoFromEnv, type PaymentProvider } from "./mercado-pago.js"
import { registerSubscriptionRoutes } from "./subscriptions.js"

/**
 * Integrações externas injetáveis. `undefined` usa a configuração de produção lida do
 * ambiente (sem variável, a integração fica desligada); `null` força "não configurada".
 */
export type CompanyAccountDependencies = {
  payments?: PaymentProvider | null
  assistant?: AssistantProvider | null
  contractWebhook?: ContractProvider | null
}

export function registerCompanyAccountRoutes(app: FastifyInstance, dependencies: AccessDependencies, io: CompanyAccountDependencies = {}) {
  const pick = <T>(injected: T | null | undefined, fromEnv: () => T | undefined) => injected === undefined ? fromEnv() : injected ?? undefined
  registerSubscriptionRoutes(app, dependencies, pick(io.payments, mercadoPagoFromEnv))
  registerAssistantRoute(app, dependencies, pick(io.assistant, assistantFromEnv))
  registerContractWebhook(app, dependencies.pool, pick(io.contractWebhook, docusealFromEnv))
}
