import assert from "node:assert/strict"
import test from "node:test"
import { proposalText, proposalTransition } from "../src/modules/proposals/schema.js"

test("proposal transitions preserve inclusive validity, revision workflow and conversion boundaries", () => {
  const today = "2026-11-16", expired = "2026-11-15"
  assert.equal(proposalTransition("draft", "send", today, today, false), "sent")
  assert.equal(proposalTransition("sent", "accept", today, today, false), "accepted")
  assert.equal(proposalTransition("sent", "reject", expired, today, false), "rejected")
  assert.equal(proposalTransition("accepted", "convert", expired, today, false), "accepted")
  for (const status of ["sent", "rejected", "accepted"]) assert.equal(proposalTransition(status, "revise", expired, today, false), "superseded")
  for (const status of ["draft", "sent", "accepted"]) {
    assert.equal(proposalTransition(status, "approve-order", today, today, false), "accepted")
    assert.equal(proposalTransition(status, "cancel", expired, today, false), "cancelled")
    assert.throws(() => proposalTransition(status, "approve-order", expired, today, false))
  }
  for (const action of ["send", "accept", "reject", "cancel", "revise", "convert", "approve-order"]) assert.throws(() => proposalTransition("accepted", action, today, today, true))
  assert.throws(() => proposalTransition("draft", "accept", today, today, false))
  assert.throws(() => proposalTransition("draft", "send", expired, today, false))
  assert.throws(() => proposalTransition("sent", "accept", expired, today, false))
})

test("proposal terms count Unicode characters and preserve permitted text", () => {
  assert.equal(proposalText(" à vista ", 7, true), "à vista")
  assert.equal(proposalText("😀", 1, true), "😀")
  assert.throws(() => proposalText(" ", 7, true))
  assert.throws(() => proposalText("invalid\0text", 20, false))
  assert.equal(proposalText("", 10, false), "")
})
