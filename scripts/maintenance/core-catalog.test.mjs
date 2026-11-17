import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoreCatalogPlan, verifyCoreCatalogReadback } from './core-catalog.mjs';

const product = { id: '11111111-1111-4111-8111-111111111111', sku: 'LD-WH001', name: 'Nome do ERP', basePrice: '14204.43', status: 'active', revision: 4, hasPhoto: true, structureColors: [], swingArmColors: [], upholsteryColors: [], finishingPalette: '' };
const source = { title: 'Planilha original', url: 'https://drive.google.com/file/d/source/view', products: [{ sku: 'LD-WH001', name: 'Agachamento Búlgaro', dimensionsMm: [1200, 1000, 900], weight: '50 kg', weightStack: '', muscleGroup: 'Pernas e glúteos', technicalCategory: 'Peso livre', pdfPage: 7 }] };

test('Core plan only creates missing technical profiles and leaves photos, colors and sale prices untouched', () => {
  const [plan] = buildCoreCatalogPlan(source, [product], [{ productId: product.id, revision: 0, data: null }]);
  assert.deepEqual(plan.after.dimensionsMm, [1200, 1000, 900]);
  assert.equal(plan.after.mainMediaId, null);
  assert.equal(plan.after.catalogProductName, 'Agachamento Búlgaro');
  assert.equal(plan.after.weight, '50 kg');
  assert.equal(plan.after.weightStack, '');
  assert.equal(plan.after.collection, 'core');
  assert.equal(plan.expectedRevision, 0);
  for (const key of ['basePrice', 'photoDataUrl', 'structureColors', 'finishingPalette', 'status', 'name']) assert.equal(Object.hasOwn(plan.after, key), false);
  assert.deepEqual(plan.beforeProduct, product);
})

test('identity conflicts, duplicate SKUs, invalid dimensions and unknown battery values stop the plan', () => {
  const catalogs = [{ productId: product.id, revision: 0, data: null }];
  assert.throws(() => buildCoreCatalogPlan(source, [], catalogs), /identidade/);
  assert.throws(() => buildCoreCatalogPlan({ ...source, products: [...source.products, source.products[0]] }, [product], catalogs), /duplicado/);
  assert.throws(() => buildCoreCatalogPlan({ ...source, products: [{ ...source.products[0], dimensionsMm: [0, 1000, 900] }] }, [product], catalogs), /dimensões/);
  assert.throws(() => buildCoreCatalogPlan({ ...source, products: [{ ...source.products[0], technicalCategory: 'Bateria de pesos', weightStack: '' }] }, [product], catalogs), /bateria/);
  assert.throws(() => buildCoreCatalogPlan(source, [{ ...product, structureColors: ['Cor não autorizada'] }], catalogs), /cores/);
})

test('existing profiles are preserved and readback detects changed protected fields', () => {
  assert.throws(() => buildCoreCatalogPlan(source, [product], [{ productId: product.id, revision: 3, data: { weight: 'Outra ficha' } }]), /já possui/);
  const [plan] = buildCoreCatalogPlan(source, [product], [{ productId: product.id, revision: 0, data: null }]);
  const saved = { ...plan.after, revision: 1, publicPath: '/core/product-id/' };
  assert.equal(verifyCoreCatalogReadback(plan, product, saved), true);
  assert.throws(() => verifyCoreCatalogReadback(plan, { ...product, basePrice: '14204.44' }, saved), /protegido/);
  assert.throws(() => verifyCoreCatalogReadback(plan, product, { ...saved, dimensionsMm: [100, 100, 100] }), /dimensões|técnico/);
  assert.throws(() => verifyCoreCatalogReadback(plan, product, { ...saved, revision: 2 }), /revisão/);
})
