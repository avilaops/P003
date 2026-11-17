import { z } from "zod"

import { Problem } from "../../platform/problem.js"

const resultSchema = z.object({
  status: z.enum(["authorized", "rejected", "uncertain", "pending", "cancelled"]),
  accessKey: z.string().regex(/^\d{50}$/).optional(),
  xml: z.string().max(1_048_576).optional(),
  code: z.string().max(80).optional(),
  reason: z.string().max(500),
}).strict()

export type FiscalEngineResult = z.infer<typeof resultSchema>
export type CertificateMaterial = { pkcs12Base64: string; password: string }

export interface OutgoingNfseEngine {
  prepare(input: Record<string, unknown>): Promise<Record<string, unknown>>
  issue(input: Record<string, unknown>): Promise<FiscalEngineResult>
  consult(input: Record<string, unknown>): Promise<FiscalEngineResult>
  cancel(input: Record<string, unknown>): Promise<FiscalEngineResult>
}

export class HttpOutgoingNfseEngine implements OutgoingNfseEngine {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchEngine: typeof fetch = fetch) {}

  private async call(path: string, input: Record<string, unknown>) {
    let response: Response
    try {
      response = await this.fetchEngine(new URL(path, `${this.baseUrl}/`), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(50_000),
      })
    } catch {
      throw new Problem(503, "fiscal_operation_uncertain", "Operação fiscal não confirmada; consulte a situação antes de repetir")
    }
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok || !body || typeof body !== "object") {
      throw new Problem(503, "fiscal_operation_uncertain", "Operação fiscal não confirmada; consulte a situação antes de repetir")
    }
    return body as Record<string, unknown>
  }

  async prepare(input: Record<string, unknown>) { return this.call("v1/prepare-nfse", input) }
  async issue(input: Record<string, unknown>) { return resultSchema.parse(await this.call("v1/issue-nfse", input)) }
  async consult(input: Record<string, unknown>) { return resultSchema.parse(await this.call("v1/consult-nfse", input)) }
  async cancel(input: Record<string, unknown>) { return resultSchema.parse(await this.call("v1/cancel-nfse", input)) }
}
