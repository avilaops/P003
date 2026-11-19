import { observe } from "./langfuse.js"

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
const DEFAULT_TIMEOUT_MS = 60_000

export type GroqMessage = { role: "system" | "user" | "assistant"; content: string }

export type GroqOptions = {
  /** Defaults to the GROQ_MODEL environment variable; there is intentionally no built-in model. */
  model?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class GroqError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = "GroqError"
  }
}

/**
 * One chat completion against Groq's OpenAI-compatible API.
 * Server-side only: reads GROQ_API_KEY and GROQ_MODEL from the environment.
 * Error messages never include prompts, completions or response bodies.
 */
export async function groqChat(messages: GroqMessage[], options: GroqOptions = {}): Promise<string> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY
  const model = options.model ?? process.env.GROQ_MODEL
  if (!apiKey) throw new GroqError("GROQ_API_KEY is not configured")
  if (!model) throw new GroqError("GROQ_MODEL is not configured")
  if (!messages.length) throw new GroqError("Groq request has no messages")

  return observe("groq-chat-completion", "generation", async () => {
    const response = await (options.fetchImpl ?? fetch)(GROQ_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) throw new GroqError(`Groq request failed with status ${response.status}`, response.status)
    const payload = (await response.json()) as { choices?: { message?: { content?: string | null } }[] }
    const text = payload.choices?.[0]?.message?.content?.trim()
    if (!text) throw new GroqError("Groq returned an empty completion", response.status)
    return text
  })
}
