import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  assertOutgoingNfseTransition,
  outgoingNfseCreateSchema,
  outgoingNfseStatusSchema,
} from "../src/modules/outgoing-nfse/model.js"

test("outgoing NFS-e input is strict and preserves monetary values as decimal strings", () => {
  const valid = {
    externalId: "invoice-2026-0001",
    environment: "homologation",
    competenceDate: "2026-11-17",
    amount: "1234.56",
    serviceCode: "010701",
    description: "Consultoria em tecnologia",
    customer: { name: "Cliente", taxId: "52998224725", email: "financeiro@example.test" },
  }
  assert.deepEqual(outgoingNfseCreateSchema.parse(valid), valid)
  assert.equal(outgoingNfseCreateSchema.safeParse({ ...valid, amount: 1234.56 }).success, false)
  assert.equal(outgoingNfseCreateSchema.safeParse({ ...valid, unknown: true }).success, false)
  assert.equal(outgoingNfseCreateSchema.safeParse({ ...valid, customer: { ...valid.customer, taxId: "123" } }).success, false)
})

test("outgoing NFS-e status transitions never retransmit an uncertain issuance", () => {
  for (const status of ["pending", "processing", "authorized", "rejected", "uncertain", "cancelled"]) {
    assert.equal(outgoingNfseStatusSchema.parse(status), status)
  }
  assert.doesNotThrow(() => assertOutgoingNfseTransition("pending", "processing"))
  assert.doesNotThrow(() => assertOutgoingNfseTransition("processing", "uncertain"))
  assert.doesNotThrow(() => assertOutgoingNfseTransition("uncertain", "authorized"))
  assert.throws(() => assertOutgoingNfseTransition("uncertain", "processing"), /consulta/i)
  assert.throws(() => assertOutgoingNfseTransition("authorized", "processing"))
})

test("outgoing NFS-e migration enforces tenant identity, immutable snapshots and append-only events", async () => {
  const sql = await readFile(new URL("../../../migrations/202611170001_outgoing_nfse.sql", import.meta.url), "utf8")
  const privileges = await readFile(new URL("../../../migrations/202611170002_outgoing_nfse_runtime_privileges.sql", import.meta.url), "utf8")
  assert.match(sql, /UNIQUE\s*\(tenant_id,\s*external_id\)/i)
  assert.match(sql, /request_snapshot_immutable/i)
  assert.match(sql, /outgoing_nfse_events_append_only/i)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/gi)
  assert.match(sql, /current_setting\('app\.tenant_id'/i)
  assert.match(privileges, /GRANT SELECT,\s*INSERT,\s*UPDATE ON fiscal_outgoing_nfse_issuances,\s*fiscal_outgoing_nfse_sequences TO erp_next_app/i)
  assert.match(privileges, /GRANT SELECT,\s*INSERT ON fiscal_outgoing_nfse_events TO erp_next_app/i)
})
