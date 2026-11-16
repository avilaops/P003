import { isDeepStrictEqual } from 'node:util';
import { getCatalogFinishPalette } from '../../apps/web/src/features/catalog/catalog-finish-palettes.ts';

const finishFields = ['structureColors', 'swingArmColors', 'upholsteryColors', 'finishingPalette'];

function target(paletteName) {
  const palette = getCatalogFinishPalette(paletteName);
  if (!palette) throw Error('Paleta desconhecida');
  const options = part => [...palette[part].standard, ...palette[part].special];
  return { structureColors: options('structure'), swingArmColors: options('swingArm'), upholsteryColors: options('upholstery'), finishingPalette: paletteName };
}

/** Pure dry run • explicit ID/SKU/source mapping, never an inference from SKU prefix. */
export function buildImportedColorPlan(rows, products, { cablePalette } = {}) {
  const seen = new Set();
  const byId = new Map(products.map(product => [product.id, product]));
  if (byId.size !== products.length) throw Error('Produto duplicado no backup');
  return rows.map(row => {
    if (seen.has(row.productId)) throw Error('Vínculo duplicado na fonte');
    seen.add(row.productId);
    const before = byId.get(row.productId);
    if (!before || before.sku !== row.sku) throw Error(`Conflito de identidade: ${row.sku}`);
    let palette;
    if (row.catalog === 'HammerForce Pro' || row.catalog === 'HammerForce Pro; Hammer S-FORCE') palette = 'dhz-hammerforce-pro';
    else if (row.catalog === 'Hammer S-FORCE') palette = 'dhz-sforce';
    else if (row.catalog === 'Cable Motion') {
      if (cablePalette !== 'dhz-combined') throw Error('Cable Motion exige autorização explícita para paleta combinada');
      palette = cablePalette;
    } else throw Error(`Catálogo sem correspondência: ${row.catalog}`);
    return { id: before.id, sku: before.sku, sourceCatalogs: row.catalog, before: structuredClone(before), after: target(palette) };
  });
}

function checkedFinishes(after) {
  if (!isDeepStrictEqual(Object.keys(after).sort(), [...finishFields].sort()) || !isDeepStrictEqual(after, target(after.finishingPalette))) throw Error('Opções fora da paleta revisada');
  return after;
}

/** Optional protected fields stay omitted so the API preserves photos and metadata. */
export function colorWriteBody(before, after) {
  return {
    sku: before.sku, name: before.name, unit: before.unit,
    basePrice: before.basePrice, ncm: before.ncm ?? null, cest: before.cest ?? null,
    status: before.status, ...checkedFinishes(after),
  };
}

export function verifyColorReadback(before, saved, after) {
  checkedFinishes(after);
  if (saved.revision !== before.revision + 1) throw Error('A revisão não corresponde à atualização única');
  for (const field of finishFields) if (!isDeepStrictEqual(saved[field], after[field])) throw Error(`Acabamento alterado inesperadamente: ${field}`);
  const protectedKeys = new Set([...Object.keys(before), ...Object.keys(saved)]);
  for (const field of protectedKeys) {
    if (field !== 'revision' && !finishFields.includes(field) && !isDeepStrictEqual(before[field], saved[field])) throw Error(`Campo protegido alterado: ${field}`);
  }
  return true;
}
