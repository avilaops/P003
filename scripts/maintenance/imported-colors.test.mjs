import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImportedColorPlan, colorWriteBody, verifyColorReadback } from './imported-colors.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const product = { id, sku: 'LD-TEST', name: 'Equipamento', revision: 7, status: 'archived', unit: 'UN', basePrice: '123.45', ncm: '95069100', cest: null, categoryId: 'category', photoDataUrl: 'original-photo', hasPhoto: true, plateHolderTypes: ['Standard'], structureColors: ['Antiga'], swingArmColors: [], upholsteryColors: ['Preto'], finishingPalette: '' };
const row = { productId: id, sku: 'LD-TEST', catalog: 'Cable Motion' };

test('Cable Motion requires explicit authorization and combined colors retain both fabric sources', () => {
  assert.throws(() => buildImportedColorPlan([row], [product]), /Cable Motion/);
  const [plan] = buildImportedColorPlan([row], [product], { cablePalette: 'dhz-combined' });
  assert.equal(plan.after.finishingPalette, 'dhz-combined');
  assert.ok(plan.after.upholsteryColors.includes('Khaki'));
  assert.ok(plan.after.upholsteryColors.includes('Mocha'));
  assert.equal(plan.before.status, 'archived');
  assert.equal(plan.after.structureColors.includes('Hermès Orange'), false);
});

test('identity, duplicate mappings and unknown catalog associations stop the entire plan', () => {
  assert.throws(() => buildImportedColorPlan([{ ...row, sku: 'OTHER' }], [product]), /identidade/);
  assert.throws(() => buildImportedColorPlan([row, row], [product], { cablePalette: 'dhz-combined' }), /duplicado/);
  assert.throws(() => buildImportedColorPlan([{ ...row, catalog: 'Unknown' }], [product]), /Catálogo/);
});

test('write allowlist preserves required values and omits protected optional fields', () => {
  const [plan] = buildImportedColorPlan([{ ...row, catalog: 'HammerForce Pro; Hammer S-FORCE' }], [product]);
  const body = colorWriteBody(product, plan.after);
  assert.equal(body.basePrice, '123.45');
  assert.equal(body.status, 'archived');
  assert.equal(body.ncm, '95069100');
  assert.equal(body.finishingPalette, 'dhz-hammerforce-pro');
  assert.equal(body.upholsteryColors.includes('Preto'), false);
  for (const field of ['photoDataUrl', 'categoryId', 'plateHolderTypes', 'revision', 'id']) assert.equal(Object.hasOwn(body, field), false);
});

test('readback accepts only requested finishes plus one revision and detects protected changes', () => {
  const [plan] = buildImportedColorPlan([row], [product], { cablePalette: 'dhz-combined' });
  const saved = { ...product, ...plan.after, revision: 8 };
  assert.equal(verifyColorReadback(product, saved, plan.after), true);
  for (const change of [{ basePrice: '123.46' }, { status: 'active' }, { photoDataUrl: 'changed' }, { plateHolderTypes: [] }, { revision: 9 }]) {
    assert.throws(() => verifyColorReadback(product, { ...saved, ...change }, plan.after), /alterado|revisão/);
  }
});
