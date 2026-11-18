import assert from "node:assert/strict"
import test from "node:test"
import type { RunCreateBody, RunSummary } from "browser-use-sdk/v4"
import { BROWSER_USE_MAX_COST_USD, BrowserUseRunError, createBrowserUseRuns, runBrowserTask, type BrowserUseRuns } from "../src/platform/browser-use.js"

const runId = "00000000-0000-4000-8000-000000000001"

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: runId, task: "t", title: "t", model: "bu-4.0", contextLimit: 0, status: "completed", result: "Top story: Example",
    error: null, sessionId: "00000000-0000-4000-8000-000000000002", workspaceId: null, totalInputTokens: 10, totalOutputTokens: 5,
    totalCostUsd: "0.04", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:10Z", ...overrides,
  } as RunSummary
}

function mockRuns(options: { wait?: () => Promise<RunSummary>; create?: () => Promise<never> } = {}) {
  const calls = { create: [] as RunCreateBody[], cancel: [] as string[], waitTimeouts: [] as (number | undefined)[] }
  const runs = {
    async create(body: RunCreateBody) {
      calls.create.push(body)
      if (options.create) return options.create()
      return { id: runId, status: "queued" }
    },
    async waitForCompletion(_id: string, wait?: { timeout?: number }) {
      calls.waitTimeouts.push(wait?.timeout)
      return options.wait ? options.wait() : summary()
    },
    async cancel(id: string) {
      calls.cancel.push(id)
      return summary({ status: "cancelled" })
    },
  } as unknown as BrowserUseRuns
  return { runs, calls }
}

test("creates a capped run without model settings and returns the validated result", async () => {
  const { runs, calls } = mockRuns()
  const result = await runBrowserTask("  Find the top Hacker News story ", { runs })
  assert.deepEqual(calls.create, [{ task: "Find the top Hacker News story", maxCostUsd: BROWSER_USE_MAX_COST_USD }])
  assert.equal(BROWSER_USE_MAX_COST_USD, 1)
  assert.deepEqual(result, { runId, sessionId: "00000000-0000-4000-8000-000000000002", result: "Top story: Example", totalCostUsd: "0.04" })
  assert.deepEqual(calls.cancel, [])
})

test("preserves an explicit model", async () => {
  const { runs, calls } = mockRuns()
  await runBrowserTask("task", { runs, model: "bu-ultrafast" })
  assert.equal(calls.create[0]?.model, "bu-ultrafast")
  assert.equal("modelParams" in (calls.create[0] ?? {}), false)
})

test("rejects failed or cancelled runs with their status", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const { runs } = mockRuns({ wait: async () => summary({ status, result: null, error: "blocked" }) })
    await assert.rejects(runBrowserTask("task", { runs }), (error: unknown) => error instanceof BrowserUseRunError && error.status === status && error.runId === runId)
  }
})

test("rejects a completed run without a usable result", async () => {
  const { runs } = mockRuns({ wait: async () => summary({ result: "   " }) })
  await assert.rejects(runBrowserTask("task", { runs }), /completed without a result/)
})

test("cancels an abandoned run when the wait fails", async () => {
  const { runs, calls } = mockRuns({ wait: async () => { throw new Error("timed out") } })
  await assert.rejects(runBrowserTask("task", { runs, timeoutMs: 5 }), /cancelled after the wait failed: timed out/)
  assert.deepEqual(calls.cancel, [runId])
  assert.deepEqual(calls.waitTimeouts, [5])
})

test("does not retry or cancel when create fails", async () => {
  const { runs, calls } = mockRuns({ create: async () => { throw new Error("network reset") } })
  await assert.rejects(runBrowserTask("task", { runs }), /network reset/)
  assert.equal(calls.create.length, 1)
  assert.deepEqual(calls.cancel, [])
})

test("refuses empty tasks and a missing API key before any request", async () => {
  await assert.rejects(runBrowserTask("   ", { runs: mockRuns().runs }), /task is empty/)
  assert.throws(() => createBrowserUseRuns(""), /BROWSER_USE_API_KEY is not configured/)
})
