import assert from "node:assert/strict";
import { test } from "node:test";
import { orderEquipmentFootprint, orderEquipmentWeight } from "../src/features/sales/order-weight-model.ts";

test("área e volume multiplicam as medidas do catálogo pela quantidade", () => {
  // LD-WH001 Agachamento Búlgaro: 1200 × 1000 × 900 mm.
  assert.deepEqual(orderEquipmentFootprint([{ quantity: "2.000000", dimensionsMm: [1200, 1000, 900] }]), { areaM2: "2.4", volumeM3: "2.16", missingDimensions: 0, invalidQuantities: false });
  assert.deepEqual(orderEquipmentFootprint([{ quantity: "1", dimensionsMm: [1200, 1000, 900] }, { quantity: "3", dimensionsMm: [2400, 1250, 1650] }]), { areaM2: "10.2", volumeM3: "15.93", missingDimensions: 0, invalidQuantities: false });
  assert.deepEqual(orderEquipmentFootprint([]), { areaM2: "0", volumeM3: "0", missingDimensions: 0, invalidQuantities: false });
});

test("área arredonda em 2 casas e volume em 3", () => {
  assert.deepEqual(orderEquipmentFootprint([{ quantity: "1", dimensionsMm: [333, 333, 333] }]), { areaM2: "0.11", volumeM3: "0.037", missingDimensions: 0, invalidQuantities: false });
  assert.equal(orderEquipmentFootprint([{ quantity: "0,5", dimensionsMm: [1005, 1000, 1000] }]).areaM2, "0.5");
});

test("medida ausente ou inválida nunca vira total parcial", () => {
  for (const dimensionsMm of [null, undefined, [], [1200, 1000], [1200, 1000, 900, 10], [0, 1000, 900], [-1, 1000, 900], [1.5, 1000, 900], ["1200", 1000, 900], [60000, 1000, 900]]) {
    assert.deepEqual(orderEquipmentFootprint([{ quantity: "1", dimensionsMm: [1200, 1000, 900] }, { quantity: "1", dimensionsMm }]), { areaM2: null, volumeM3: null, missingDimensions: 1, invalidQuantities: false });
  }
});

test("quantidade inválida impede área e volume", () => {
  for (const quantity of ["", "0", "-1", "1e3", "1.0000001"]) {
    assert.deepEqual(orderEquipmentFootprint([{ quantity, dimensionsMm: [1200, 1000, 900] }]), { areaM2: null, volumeM3: null, missingDimensions: 0, invalidQuantities: true });
  }
});

test("peso total multiplica cada equipamento pela quantidade e conserva decimais", () => {
  assert.deepEqual(orderEquipmentWeight([{ quantity: "6.000000", weight: "180,5 kg" }, { quantity: "2", weight: "90.25 KG" }]), { totalKg: "1263.5", missingWeights: 0, invalidQuantities: false });
  assert.equal(orderEquipmentWeight([{ quantity: "0,125", weight: "0.001 kg" }]).totalKg, "0.000125");
  assert.equal(orderEquipmentWeight([{ quantity: "999999999999.999999", weight: "0.000001" }]).totalKg, "999999.999999999999");
});

test("peso incompleto nunca é publicado como zero ou como total parcial", () => {
  for (const weight of [null, undefined, "", "0 kg", "-1 kg", "10 lb", "aprox. 200 kg", "10-20 kg", "1e3", "NaN", "1.", "1,"]) {
    assert.deepEqual(orderEquipmentWeight([{ quantity: "2", weight: "100 kg" }, { quantity: "1", weight }]), { totalKg: null, missingWeights: 1, invalidQuantities: false });
  }
});

test("quantidade alterada ou removida recalcula o peso e quantidade inválida impede total", () => {
  assert.equal(orderEquipmentWeight([{ quantity: "1", weight: "180 kg" }]).totalKg, "180");
  assert.equal(orderEquipmentWeight([{ quantity: "2", weight: "180 kg" }]).totalKg, "360");
  assert.equal(orderEquipmentWeight([]).totalKg, "0");
  for (const quantity of ["", "0", "-1", "1e3", "1.0000001"]) {
    assert.deepEqual(orderEquipmentWeight([{ quantity, weight: "180 kg" }]), { totalKg: null, missingWeights: 0, invalidQuantities: true });
  }
});
