import assert from "node:assert/strict";
import { test } from "node:test";
import { applySuggestedWeight, blankDraft } from "../src/features/fiscal/nfe-draft-model.ts";

test("peso do pedido preenche peso líquido e bruto do transporte da NF-e", () => {
  const draft = applySuggestedWeight(blankDraft(), "2775.000");
  assert.equal(draft.transport?.netWeight, "2775.000");
  assert.equal(draft.transport?.grossWeight, "2775.000");
  assert.equal(draft.transport?.volumes, null);
});

test("peso já digitado na NF-e nunca é sobrescrito", () => {
  const typed = { ...blankDraft(), transport: { ...applySuggestedWeight(blankDraft(), "1.000").transport, netWeight: "2700.000", grossWeight: "2900.000" } };
  const draft = applySuggestedWeight(typed, "2775.000");
  assert.equal(draft.transport?.netWeight, "2700.000");
  assert.equal(draft.transport?.grossWeight, "2900.000");
});

test("sem peso calculado o rascunho fica como estava", () => {
  const draft = blankDraft();
  assert.equal(applySuggestedWeight(draft, null), draft);
  assert.equal(applySuggestedWeight(draft, undefined), draft);
  assert.equal(applySuggestedWeight(draft, ""), draft);
});
