import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch } from "../src/engine.ts";
import { prepareNationalNfse } from "../src/lib/fiscal/nfse-issuance.ts";

function validInput() {
  return {
    environment: "homologation" as const,
    issuedAt: "2026-11-17T10:30:00-03:00",
    competence: "2026-11-17",
    applicationVersion: "avilaops-erp-1",
    series: "1",
    number: "1",
    issuer: {
      taxId: "04252011000110",
      name: "Ávila Ops Serviços",
      municipalityCode: "3543402",
    },
    recipient: {
      taxId: "19131243000197",
      name: "Cliente de teste",
    },
    service: {
      municipalityCode: "3543402",
      nationalTaxCode: "010101",
      description: "Serviço sintético para homologação.",
    },
    amount: "123.45",
    taxation: {
      issTaxation: "1",
      issWithholding: "1",
      totalTaxIndicator: "0",
    },
  };
}

test("prepareNationalNfse creates an exact MEI DPS for Ribeirão Preto and validates the DPS root schema", async () => {
  const result = await prepareNationalNfse(validInput());

  assert.equal(result.id, "DPS354340220425201100011000001000000000000001");
  assert.equal(result.version, "1.01");
  assert.equal(result.environment, "homologation");
  assert.equal(result.amountCents, "12345");
  assert.deepEqual(result.verification, {
    layout: "local_profile_valid",
    correction: "nfse-1.01-dps-series-regex-v1",
  });
  assert.match(result.xml, /<cLocEmi>3543402<\/cLocEmi>/);
  assert.match(result.xml, /<opSimpNac>2<\/opSimpNac>/);
  assert.match(result.xml, /<CNPJ>19131243000197<\/CNPJ>/);
  assert.match(result.xml, /<vServ>123\.45<\/vServ>/);
});

test("prepareNationalNfse preserves CPF and CNPJ recipient identity without inference from other fields", async () => {
  const company = await prepareNationalNfse(validInput());
  assert.match(company.xml, /<toma><CNPJ>19131243000197<\/CNPJ>/);

  const personInput = validInput();
  personInput.recipient.taxId = "52998224725";
  const person = await prepareNationalNfse(personInput);
  assert.match(person.xml, /<toma><CPF>52998224725<\/CPF>/);
  assert.doesNotMatch(person.xml, /<toma><CNPJ>/);
});

test("prepareNationalNfse rejects invalid money, competence, municipality, tax IDs and unknown fields before producing XML", async () => {
  const invalidInputs: unknown[] = [
    { ...validInput(), amount: 123.45 },
    { ...validInput(), amount: "123.456" },
    { ...validInput(), competence: "2026-02-30" },
    { ...validInput(), issuer: { ...validInput().issuer, municipalityCode: "3550308" } },
    { ...validInput(), recipient: { ...validInput().recipient, taxId: "00000000000000" } },
    { ...validInput(), unexpected: true },
    { ...validInput(), service: { ...validInput().service, unexpected: true } },
  ];

  for (const input of invalidInputs) await assert.rejects(() => prepareNationalNfse(input));
});

test("dispatch exposes prepare-nfse without requiring a certificate or transport", async () => {
  let transmissions = 0;
  const result = await dispatch("prepare-nfse", validInput(), async () => {
    transmissions++;
    throw new Error("transport must not run");
  });

  assert.equal(result.id, "DPS354340220425201100011000001000000000000001");
  assert.equal(transmissions, 0);
});
