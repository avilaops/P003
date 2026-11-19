import type { FastifyInstance } from "fastify"
import { Readable } from "node:stream"
import { z } from "zod"

import { authorizeRequest, type AccessDependencies } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { AssistantUnavailable, type AssistantProvider } from "./assistant-provider.js"
import { ChatError, executeTool, invalidChat, navigationRequest, parseCall, unavailable, type CallArguments } from "./assistant-tools.js"

const input = z.strictObject({ questions: z.array(z.string()) })

function validate(questions: string[]) {
  if (!questions.length || questions.length > 6 || questions.some(question => !question.trim() || [...question].length > 1000)
    || questions.reduce((sum, question) => sum + Buffer.byteLength(question), 0) > 6000)
    throw invalidChat("Envie até seis perguntas de até 1.000 caracteres, totalizando até 6.000 bytes.")
}

// Falhas de acesso viram o corpo `{title}` do contrato do assistente, não problem+json.
function chatError(error: unknown): ChatError {
  if (error instanceof ChatError) return error
  if (error instanceof AssistantUnavailable) return unavailable(error.message)
  if (error instanceof Problem) {
    if (error.code === "forbidden") return new ChatError(403, "Consulta recusada: você não tem permissão nesta empresa.")
    if (error.code === "missing_tenant" || error.code === "invalid_tenant") return invalidChat("Empresa ativa inválida.")
  }
  return unavailable("Não foi possível consultar o ERP. Nenhum resultado foi confirmado.")
}

export function registerAssistantRoute(app: FastifyInstance, dependencies: AccessDependencies, assistant: AssistantProvider | undefined) {
  let busy = false // capacidade de inferência: uma consulta por vez, como no Rust
  const line = (value: unknown) => JSON.stringify(value) + "\n"
  app.post("/api/v1/assistant", async (request, reply) => {
    const fail = (error: ChatError) => reply.code(error.status).header("cache-control", "no-store").send({ title: error.title })
    try {
      const parsed = input.safeParse(request.body)
      if (!parsed.success) throw invalidChat("Pergunta inválida.")
      const { questions } = parsed.data
      validate(questions)
      // Confere o vínculo com a empresa mesmo para conversa simples, antes de qualquer inferência.
      await authorizeRequest(request, dependencies, async () => undefined, false)
      if (!assistant) throw unavailable("Assistente indisponível: o serviço de IA ainda não está configurado.")
      if (busy) throw new ChatError(429, "O assistente está atendendo outra consulta. Tente novamente em instantes.")
      busy = true
      const abort = new AbortController()
      reply.raw.once("close", () => abort.abort())
      const question = questions.at(-1)!
      async function* stream() {
        try {
          yield line({ type: "status", text: "Preparando resposta…" })
          const plan: [string, CallArguments][] = []
          const navigation = navigationRequest(question)
          if (navigation) plan.push(["localizar_funcionalidade", { kind: "search", q: navigation.q }])
          else {
            const reply = await assistant!.generate(questions, abort.signal)
            if (!reply.toolCalls.length) { yield line({ type: "answer", text: reply.content, kind: "model", model: assistant!.model }); yield line({ type: "done" }); return }
            // Valida o plano inteiro antes de executar qualquer ferramenta.
            for (const call of reply.toolCalls) plan.push([call.name, parseCall(call.name, call.arguments, question)])
          }
          const results: Record<string, any>[] = []
          for (const [name, args] of plan) {
            yield line({ type: "tool", name })
            const result = await executeTool(app, dependencies, request as never, name, args)
            yield line({ type: "source", source: result })
            results.push(result)
          }
          if (results.every(result => Array.isArray(result.data) && result.data.length === 0))
            yield line({ type: "answer", kind: "erp", text: "Nenhum resultado encontrado. Confira o nome, SKU ou identificador informado e tente novamente." })
          else if (results.every(result => result.tool === "localizar_funcionalidade"))
            yield line({ type: "answer", kind: "erp", text: "Encontrei as funcionalidades disponíveis nas fontes abaixo." })
          else {
            yield line({ type: "status", text: "Preparando resumo dos resultados…" })
            yield line({ type: "answer", kind: "model", text: await assistant!.summarize(question, results, abort.signal), model: assistant!.model })
          }
          yield line({ type: "done" })
        } catch (error) {
          if (abort.signal.aborted && !timedOut) return
          const failure = timedOut ? unavailable("A consulta excedeu o tempo limite. Tente novamente.") : chatError(error)
          yield line({ type: "error", status: failure.status, title: failure.title })
        }
      }
      // Limite total de 100 s; fechar a conexão cancela inferência e libera a capacidade.
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; abort.abort() }, 100_000)
      timeout.unref()
      const body = Readable.from(stream())
      body.once("close", () => { clearTimeout(timeout); abort.abort(); busy = false })
      return reply.header("content-type", "application/x-ndjson; charset=utf-8").header("cache-control", "no-store").header("x-accel-buffering", "no").send(body)
    } catch (error) {
      return fail(chatError(error))
    }
  })
}
