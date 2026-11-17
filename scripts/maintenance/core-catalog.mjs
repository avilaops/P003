import { isDeepStrictEqual } from 'node:util';

/** Plan-only • imported measurements never change product prices or images. */
export function buildCoreCatalogPlan(source, products, catalogs) {
  if (!source?.products?.length || !source.title || new URL(source.url).protocol !== 'https:') throw Error('Fonte técnica inválida');
  const bySku = new Map(products.map(product => [product.sku, product]));
  const byId = new Map(catalogs.map(catalog => [catalog.productId, catalog]));
  if (bySku.size !== products.length || byId.size !== catalogs.length) throw Error('Cadastro duplicado no backup');
  const seen = new Set();
  return source.products.map(row => {
    if (seen.has(row.sku)) throw Error('SKU duplicado na fonte');
    seen.add(row.sku);
    const product = bySku.get(row.sku);
    const catalog = product && byId.get(product.id);
    if (!product || !/^LD-WH\d{3}$/.test(row.sku) || !catalog) throw Error(`Conflito de identidade ou backup ausente: ${row.sku}`);
    if (catalog.data) throw Error(`O produto já possui ficha técnica; não sobrescrever: ${row.sku}`);
    if (catalog.revision !== 0) throw Error('A revisão não representa uma ficha nova');
    if ([product.structureColors, product.swingArmColors, product.upholsteryColors].some(colors => colors?.length) || product.finishingPalette) throw Error('A linha nacional não possui seleção de cores; confira o cadastro');
    if (!Array.isArray(row.dimensionsMm) || row.dimensionsMm.length !== 3 || row.dimensionsMm.some(value => !Number.isSafeInteger(value) || value < 1 || value > 50000)) throw Error(`Confira as dimensões: ${row.sku}`);
    if (!/^\d+(?:[.,]\d+)? kg$/.test(row.weight)) throw Error(`Peso não confirmado: ${row.sku}`);
    if (/bateria/i.test(row.technicalCategory) && !row.weightStack?.trim()) throw Error(`Valor de bateria não confirmado: ${row.sku}`);
    const catalogSources = [{ title: source.title, url: source.url }];
    if (source.pdfUrl && row.pdfPage) catalogSources.push({ title: source.pdfTitle, url: `${source.pdfUrl}#page=${row.pdfPage}`, pdfPage: row.pdfPage, printedPage: row.pdfPage });
    const after = { collection: 'core', muscleGroup: row.muscleGroup, technicalCategory: row.technicalCategory, dimensionsMm: [...row.dimensionsMm], description: '', weight: row.weight, weightStack: row.weightStack || '', mainMediaId: null, catalogProductName: row.name, catalogSources };
    return { id: product.id, sku: row.sku, expectedRevision: 0, beforeProduct: structuredClone(product), beforeProfile: null, after };
  });
}

export function verifyCoreCatalogReadback(plan, product, profile) {
  if (!isDeepStrictEqual(product, plan.beforeProduct)) throw Error(`Campo protegido do produto foi alterado: ${plan.sku}`);
  if (profile.revision !== plan.expectedRevision + 1) throw Error(`Confira a revisão: ${plan.sku}`);
  for (const [key, value] of Object.entries(plan.after)) if (!isDeepStrictEqual(profile[key], value)) throw Error(`Campo técnico alterado: ${plan.sku} • ${key}`);
  return true;
}
