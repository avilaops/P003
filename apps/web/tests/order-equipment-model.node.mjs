import assert from "node:assert/strict";
import { test } from "node:test";
import { compatibleOrderFinishUpdates, orderEquipmentAmounts, orderEquipmentPrice } from "../src/features/sales/order-equipment-model.ts";

const item = (id, overrides = {}) => ({
  line: "imported", versionId: "v1", productId: id, quantity: "1", structureColor: "", swingArmColor: "",
  upholsteryColor: "", plateHolderColor: "", plateHolderType: "", ...overrides,
});
const finishes = (id, overrides = {}) => ({
  id, name: id, structureColors: ["Preto"], swingArmColors: ["Prata"], finishingPalette: null,
  upholsteryColors: ["Azul"], upholsteryConfigurable: true, plateHolderColors: [], plateHolderTypes: ["Olímpico"], weight: null,
  ...overrides,
});
const price = (id, overrides = {}) => ({
  line: "imported", versionId: "v1", productId: id, sku: id, name: id, unit: "un.",
  priceWithoutIpiCents: 10000, priceWithIpiCents: 11300, ipiBps: 1300, ...overrides,
});

test("cópia de cores atualiza somente partes compatíveis e preserva o tipo de anilheiro", () => {
  const source = item("source", { structureColor: "Preto", swingArmColor: "Prata", upholsteryColor: "Azul", plateHolderType: "Olímpico" });
  const target = item("target", { structureColor: "Cinza", swingArmColor: "Branco", upholsteryColor: "Vermelho", plateHolderType: "Standard" });
  const national = item("national", { line: "national", structureColor: "Cinza" });
  const pending = item("pending");
  const products = {
    target: finishes("target", { swingArmColors: ["Branco"], upholsteryConfigurable: false }),
    national: finishes("national"),
  };

  assert.deepEqual(compatibleOrderFinishUpdates(source, [source, target, national, pending], products), {
    updates: [{ ...target, structureColor: "Preto" }],
    skipped: [
      { productId: "target", parts: ["Braços", "Estofado"] },
      { productId: "national", parts: ["Estrutura", "Braços", "Estofado"] },
      { productId: "pending", parts: ["Estrutura", "Braços", "Estofado"] },
    ],
  });
  assert.deepEqual(compatibleOrderFinishUpdates(national, [national, target], products), { updates: [], skipped: [] });
});

test("valores de tabela seguem a versão selecionada e a quantidade válida", () => {
  const selected = item("equip", { quantity: "2" });
  const prices = [price("equip", { versionId: "v2", priceWithIpiCents: 9999 }), price("equip")];
  const selectedPrice = orderEquipmentPrice(selected, prices);

  assert.deepEqual(orderEquipmentAmounts(selected, selectedPrice, undefined), {
    tableUnitCents: 10000, tableLineCents: 22600, discountCents: null, simulatedLineCents: null,
  });
  assert.deepEqual(orderEquipmentAmounts(selected, selectedPrice, { quantity: 1, tableUnitCents: 10000, netCents: 9000, totalCents: 10170 }), {
    tableUnitCents: 10000, tableLineCents: 22600, discountCents: null, simulatedLineCents: null,
  });
  assert.deepEqual(orderEquipmentAmounts(selected, selectedPrice, { quantity: 2, tableUnitCents: 10000, netCents: 18000, totalCents: 20340 }), {
    tableUnitCents: 10000, tableLineCents: 22600, discountCents: 2000, simulatedLineCents: 20340,
  });
  assert.equal(orderEquipmentAmounts({ ...selected, quantity: "0" }, selectedPrice, undefined).tableLineCents, null);
  assert.equal(orderEquipmentAmounts(selected, price("equip", { available: false }), undefined).tableLineCents, null);
});
