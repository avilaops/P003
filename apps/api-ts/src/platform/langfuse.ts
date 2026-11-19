import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"

/**
 * Metadata-only Langfuse tracing over OTLP/HTTP JSON (port of apps/api platform/langfuse.rs).
 * Opt-in, never exports payloads, and exporter failures never affect the caller.
 */
const SERVICE = "erp-next"
const ENVIRONMENTS = ["development", "test", "staging", "production"] as const
const MAX_QUEUE = 512
const BATCH_SIZE = 64
const FLUSH_INTERVAL_MS = 5_000
const EXPORT_TIMEOUT_MS = 3_000

export type LangfuseConfiguration = {
  endpoint: string
  authorization: string
  environment: (typeof ENVIRONMENTS)[number]
  sampleRate: number
}

type Getter = (name: string) => string | undefined
type Attribute = { key: string; value: { stringValue: string } }
type Span = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: 1
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  status: { code: 1 | 2; message?: string }
}
type Context = { traceId: string; spanId: string }

/** Returns null when disabled; throws a fixed, non-secret message when the configuration is unsafe. */
export function configuration(get: Getter): LangfuseConfiguration | null {
  if (get("LANGFUSE_ENABLED") !== "true") return null
  for (const name of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"])
    if (get(name)?.trim()) throw new Error("ambient OTLP headers are not permitted for Langfuse")
  const required = (name: string) => {
    const value = get(name)?.trim()
    if (!value) throw new Error("missing Langfuse configuration")
    return value
  }
  const base = required("LANGFUSE_BASE_URL")
  let url: URL
  try { url = new URL(base) } catch { throw new Error("invalid Langfuse URL") }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname)
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash)
    throw new Error("Langfuse requires HTTPS or literal loopback without URL credentials")
  const publicKey = required("LANGFUSE_PUBLIC_KEY")
  const secretKey = required("LANGFUSE_SECRET_KEY")
  const environment = get("LANGFUSE_TRACING_ENVIRONMENT") ?? "development"
  if (!ENVIRONMENTS.includes(environment as never)) throw new Error("invalid Langfuse environment")
  const sampleRate = Number(get("LANGFUSE_SAMPLE_RATE") ?? "1")
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error("invalid Langfuse sample rate")
  return {
    endpoint: `${base.replace(/\/+$/, "")}/api/public/otel/v1/traces`,
    authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
    environment: environment as LangfuseConfiguration["environment"],
    sampleRate,
  }
}

const attr = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } })
const nanos = () => (BigInt(Date.now()) * 1_000_000n).toString()
const context = new AsyncLocalStorage<Context>()

let active: LangfuseConfiguration | null = null
let version = "0.0.0"
let queue: Span[] = []
let timer: NodeJS.Timeout | undefined

/** Call once at startup. Invalid or missing configuration disables tracing instead of failing the service. */
export function init(options: { get?: Getter; serviceVersion?: string } = {}) {
  try {
    active = configuration(options.get ?? ((name) => process.env[name]))
  } catch {
    console.warn("Langfuse tracing disabled: invalid or missing configuration")
    active = null
  }
  version = options.serviceVersion ?? version
  if (active && !timer) {
    timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)
    timer.unref()
  }
}

async function send(config: LangfuseConfiguration, spans: Span[]) {
  const body = {
    resourceSpans: [{
      resource: { attributes: [
        attr("service.name", SERVICE),
        attr("service.version", version),
        attr("deployment.environment.name", config.environment),
      ] },
      scopeSpans: [{ scope: { name: SERVICE }, spans }],
    }],
  }
  try {
    await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: config.authorization,
        "Content-Type": "application/json",
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })
  } catch {
    // Export failures never block or fail the service.
  }
}

export async function flush() {
  const config = active
  if (!config) return
  while (queue.length) await send(config, queue.splice(0, BATCH_SIZE))
}

/** Flush the bounded queue before process exit. */
export async function shutdown() {
  if (timer) clearInterval(timer)
  timer = undefined
  await flush()
  active = null
}

/**
 * Names and kinds must be fixed application constants, never user arguments.
 * Only success/error status is recorded; input and output content is always omitted.
 */
export async function observe<T>(
  name: string,
  kind: "span" | "tool" | "generation",
  operation: () => Promise<T>,
  rejected: (value: T) => boolean = () => false,
): Promise<T> {
  const config = active
  const parent = context.getStore()
  if (!config || (!parent && Math.random() >= config.sampleRate)) return operation()

  const own: Context = { traceId: parent?.traceId ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") }
  const startTimeUnixNano = nanos()
  let failed = true
  let interrupted = true
  try {
    const result = await context.run(own, operation)
    failed = rejected(result)
    interrupted = false
    return result
  } catch (error) {
    interrupted = false
    throw error
  } finally {
    const span: Span = {
      traceId: own.traceId,
      spanId: own.spanId,
      name,
      kind: 1,
      startTimeUnixNano,
      endTimeUnixNano: nanos(),
      attributes: [
        attr("langfuse.observation.type", kind),
        attr("langfuse.version", version),
        attr("langfuse.environment", config.environment),
        attr("langfuse.observation.metadata.service", SERVICE),
        attr("langfuse.observation.input", '{"content":"omitted"}'),
        attr("langfuse.observation.output", failed ? '{"status":"error"}' : '{"status":"success"}'),
      ],
      status: failed ? { code: 2, message: interrupted ? "operation interrupted" : "operation failed" } : { code: 1 },
      ...(parent ? { parentSpanId: parent.spanId } : {}),
    }
    if (queue.length < MAX_QUEUE) queue.push(span)
    if (queue.length >= BATCH_SIZE) void flush()
  }
}
