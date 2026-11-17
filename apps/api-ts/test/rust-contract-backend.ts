import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createServer as createPortLease } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import { stringifyJson } from "../src/platform/json.js"
import { authContractProfile } from "./auth-contract-fixture.js"

export async function startRustContractBackend(binary: string, databaseUrl: string, role: string, typescriptOrigin?: string): Promise<FastifyInstance> {
  const auth = createServer((request, response) => {
    const authorization = request.headers.authorization ?? ""
    response.setHeader("content-type", "application/json")
    const fixture = authContractProfile(authorization.slice(7))
    response.statusCode = fixture.status
    response.end(JSON.stringify(fixture.profile))
  })
  await new Promise<void>(resolve => auth.listen(0, "127.0.0.1", resolve))
  const authAddress = auth.address()
  if (!authAddress || typeof authAddress === "string") throw Error("Auth fixture did not bind")
  const lease = createPortLease()
  await new Promise<void>(resolve => lease.listen(0, "127.0.0.1", resolve))
  const address = lease.address()
  if (!address || typeof address === "string") throw Error("Rust fixture did not reserve a port")
  await new Promise<void>((resolve, reject) => lease.close(error => error ? reject(error) : resolve()))
  const url = new URL(databaseUrl)
  // The connection assumes the same restricted NOLOGIN role as the TS adapter.
  url.searchParams.set("options", `-c role=${role}`)
  const environment: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  Object.assign(environment, { DATABASE_URL: url.toString(), DATABASE_MAX_CONNECTIONS: "5", API_BIND_ADDRESS: `127.0.0.1:${address.port}`, AUTH_USERINFO_URL: `http://127.0.0.1:${authAddress.port}/userinfo`, ERP_BACKGROUND_WORKERS_ENABLED: "false", NFE_PRODUCTION_ENABLED: "false", RUST_LOG: "error" })
  if (typescriptOrigin) environment.ERP_TYPESCRIPT_API_URL = typescriptOrigin
  const child = spawn(resolve(binary), [], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = "", failure: Error | undefined, exited = false
  child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-4000) })
  child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-4000) })
  const exit = new Promise<void>(resolve => {
    child.once("error", error => { failure = error; exited = true; resolve() })
    child.once("exit", () => { exited = true; resolve() })
  })
  const close = async () => {
    if (!exited) child.kill("SIGTERM")
    await exit
    auth.closeAllConnections()
    await new Promise<void>((resolve, reject) => auth.close(error => error ? reject(error) : resolve()))
  }
  const origin = `http://127.0.0.1:${address.port}`
  try {
    let ready = false
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (exited) throw failure ?? Error(`Rust contract backend exited: ${output}`)
      try {
        const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(500) })
        if (response.ok && (await response.json() as { status?: string }).status === "ready") { ready = true; break }
        await response.body?.cancel()
      } catch { /* Only the owned local process is being probed. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!ready) throw Error(`Rust contract backend did not become ready: ${output}`)
  } catch (error) { await close(); throw error }
  // Test helpers use only inject() and close(). Requests reach the actual Rust
  // HTTP server; this adapter provides the assertion interface used for Fastify.
  return {
    async inject(options: { url: string; method?: string; headers?: Record<string, string | string[]>; payload?: unknown }) {
      const headers = new Headers()
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (Array.isArray(value)) for (const item of value) headers.append(key, item)
        else headers.set(key, value)
      }
      let body: string | undefined
      if (options.payload !== undefined) {
        if (typeof options.payload === "string") body = options.payload
        else { body = stringifyJson(options.payload); if (!headers.has("content-type")) headers.set("content-type", "application/json") }
      }
      const response = await fetch(new URL(options.url, origin), { method: options.method ?? "GET", headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal: AbortSignal.timeout(15000) })
      const text = await response.text()
      return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: text, payload: text, json: () => JSON.parse(text) } as LightMyRequestResponse
    },
    close,
  } as unknown as FastifyInstance
}
