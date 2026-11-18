import type { FastifyInstance } from "fastify"
import type { DatabasePool } from "../../platform/database.js"
import { consumeInvoices } from "./accrual.js"

// The fiscal emitter commits the event first. This worker can restart between attempts.
export async function processInvoiceQueue(pool: DatabasePool, failed: (error: unknown, tenant: string) => void) {
  const discovery = await pool.connect()
  let tenants
  try {
    tenants = (await discovery.query("SELECT tenant_id FROM finance_pending_invoice_tenants() AS tenant_id")).rows
  } finally {
    discovery.release()
  }
  for (const row of tenants) {
    const tenant = String(row.tenant_id),
      client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject','finance-invoice-worker',true)",
        [tenant],
      )
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenant])
      const identity = {
        subject: "finance-invoice-worker",
        name: "Contabilização fiscal",
        email: "",
        emailVerified: false,
      }
      await consumeInvoices({ client, tenantId: tenant, authSubject: identity.subject, permissions: [], identity }, {})
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      failed(error, tenant)
    } finally {
      client.release()
    }
  }
}
export function registerInvoiceWorker(app: FastifyInstance, pool: DatabasePool) {
  let timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined
  const poll = () => {
    if (running) return
    running = processInvoiceQueue(pool, (err, tenantId) =>
      app.log.error({ err, tenantId }, "Falha ao processar evento fiscal financeiro"),
    )
      .catch((err) => app.log.error({ err }, "Fila fiscal financeira indisponível"))
      .finally(() => {
        running = undefined
      })
  }
  app.addHook("onListen", async () => {
    poll()
    timer = setInterval(poll, 30000)
    timer.unref()
  })
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer)
    await running
  })
}
