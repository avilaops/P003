import { BrowserUse, type RunCreateBody, type RunSummary } from "browser-use-sdk/v4"

/** Hard budget for every run, in USD (model and search charges). */
export const BROWSER_USE_MAX_COST_USD = 1
/** Client-side wait before the run is treated as abandoned and cancelled. */
export const BROWSER_USE_DEFAULT_TIMEOUT_MS = 10 * 60_000

export type BrowserUseRuns = Pick<BrowserUse["runs"], "create" | "waitForCompletion" | "cancel">

export type BrowserTaskOptions = {
  runs?: BrowserUseRuns
  timeoutMs?: number
  /** Explicit model choice. Omitted means the project default (and its default reasoning). */
  model?: RunCreateBody["model"]
}

export type BrowserTaskResult = {
  runId: string
  sessionId: string
  result: string
  totalCostUsd: string
}

export class BrowserUseRunError extends Error {
  constructor(message: string, readonly runId?: string, readonly status?: RunSummary["status"]) {
    super(message)
    this.name = "BrowserUseRunError"
  }
}

/** Server-side only: reads BROWSER_USE_API_KEY from the environment. */
export function createBrowserUseRuns(apiKey = process.env.BROWSER_USE_API_KEY): BrowserUseRuns {
  if (!apiKey) throw new BrowserUseRunError("BROWSER_USE_API_KEY is not configured")
  return new BrowserUse({ apiKey }).runs
}

/**
 * Runs one Cloud V4 agent task, capped at $1, and returns its validated result.
 * A failed create is not retried, because the run may already exist.
 * A run that is not finished within the timeout is cancelled before throwing.
 */
export async function runBrowserTask(task: string, options: BrowserTaskOptions = {}): Promise<BrowserTaskResult> {
  const goal = task.trim()
  if (!goal) throw new BrowserUseRunError("Browser Use task is empty")

  const runs = options.runs ?? createBrowserUseRuns()
  const created = await runs.create({
    task: goal,
    maxCostUsd: BROWSER_USE_MAX_COST_USD,
    ...(options.model ? { model: options.model } : {}),
  })

  let summary: RunSummary
  try {
    summary = await runs.waitForCompletion(created.id, { timeout: options.timeoutMs ?? BROWSER_USE_DEFAULT_TIMEOUT_MS })
  } catch (error) {
    await runs.cancel(created.id).catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new BrowserUseRunError(`Browser Use run ${created.id} was cancelled after the wait failed: ${reason}`, created.id)
  }

  if (summary.status !== "completed") {
    throw new BrowserUseRunError(`Browser Use run ${summary.id} ended as ${summary.status}: ${summary.error ?? "no error detail"}`, summary.id, summary.status)
  }

  const result = summary.result?.trim()
  if (!result) throw new BrowserUseRunError(`Browser Use run ${summary.id} completed without a result`, summary.id, summary.status)

  return { runId: summary.id, sessionId: summary.sessionId, result, totalCostUsd: summary.totalCostUsd }
}
