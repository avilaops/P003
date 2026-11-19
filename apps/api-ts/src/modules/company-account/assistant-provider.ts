/** Falha do provedor de IA com a mensagem que o usuário pode ver. */
export class AssistantUnavailable extends Error {}

export type ModelToolCall = { name: string; arguments: unknown }
export type ModelMessage = { content: string; toolCalls: ModelToolCall[] }

/** Interface do provedor de IA; nos testes é substituída por um falso, sem chamada externa. */
export interface AssistantProvider {
  readonly model: string
  generate(questions: string[], signal?: AbortSignal): Promise<ModelMessage>
  summarize(question: string, results: unknown[], signal?: AbortSignal): Promise<string>
}
