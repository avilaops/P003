import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const moduleUrl = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const palettes = ts.transpileModule(readFileSync(new URL("../src/features/catalog/catalog-finish-palettes.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const model = ts.transpileModule(readFileSync(new URL("../src/features/catalog/catalog-color-photo-model.ts", import.meta.url), "utf8").replace('"./catalog-finish-palettes.ts"', JSON.stringify(moduleUrl(palettes))), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
function compileComponent(source) {
  const resolved = source.replace(/from "(react|lucide-react|@base-ui\/react\/(?:select|popover))"/g, (_match, specifier) => `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`)
    .replace(/^import "[^"\n]+\.css";?\r?\n/gm, "");
  return ts.transpileModule(`import React from ${JSON.stringify(pathToFileURL(require.resolve("react")).href)};\n${resolved}`, { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
}
const picker = compileComponent(readFileSync(new URL("../src/features/catalog/catalog-color-picker.tsx", import.meta.url), "utf8")
  .replace('"./catalog-color-photo-model"', JSON.stringify(moduleUrl(model)))
  .replace('"./catalog-finish-palettes"', JSON.stringify(moduleUrl(palettes))));
const component = readFileSync(new URL("../src/features/catalog/catalog-color-photos.tsx", import.meta.url), "utf8")
  .replace('"./catalog-color-photo-model"', JSON.stringify(moduleUrl(model)))
  .replace('"./catalog-finish-palettes"', JSON.stringify(moduleUrl(palettes)))
  .replace('"./catalog-color-picker"', JSON.stringify(moduleUrl(picker)));
const compiled = compileComponent(component);
const { CatalogColorPhotos } = await import(moduleUrl(compiled));

test("product detail presents one compact original preview without disabled tint or editing controls", () => {
  const html = renderToStaticMarkup(React.createElement(CatalogColorPhotos, { label: "Braços", part: "swingArm", options: ["Piano Black", "Hermès Orange", "Amarelo"], palette: "dhz-hammerforce-pro", readOnly: true }));
  assert.equal((html.match(/background-image/g) ?? []).length, 1);
  assert.match(html, /3 opções/);
  assert.match(html, /Ver opções de Braços/);
  assert.doesNotMatch(html, /<input|disabled|opacity-50|aria-pressed/);
  assert.match(html, /dhz-hammerforce-pro-original-colors.jpeg/);
});

test("the compact unknown-finish summary counts options without invented photos", () => {
  const html = renderToStaticMarkup(React.createElement(CatalogColorPhotos, { label: "Estrutura", part: "structure", options: ["Preto", "Amarelo"], readOnly: true }));
  assert.match(html, /2 opções/);
  assert.match(html, /Ver opções de Estrutura/);
  assert.doesNotMatch(html, /background-image|catálogo DHZ ·/);
});

test("upholstery and selected signature previews keep their own catalog material", () => {
  const fabric = renderToStaticMarkup(React.createElement(CatalogColorPhotos, { label: "Estofado", part: "upholstery", options: ["Black", "Khaki", "Mocha"], palette: "dhz-sforce", readOnly: true }));
  assert.equal((fabric.match(/background-image/g) ?? []).length, 1);
  assert.match(fabric, /3 opções/);
  assert.match(fabric, /dhz-s-force-original-colors.jpeg/);
  assert.doesNotMatch(fabric, /dhz-hammerforce-pro-original-colors.jpeg/);
  const paint = renderToStaticMarkup(React.createElement(CatalogColorPhotos, { label: "Estrutura", part: "structure", options: ["Piano Black", "Titanium Grey"], palette: "dhz-hammerforce-pro", value: "Titanium Grey", onChange() {} }));
  assert.match(paint, /role="combobox"/);
  assert.match(paint, /Titanium Grey/);
  assert.match(paint, /dhz-hammerforce-pro-original-colors.jpeg/);
  assert.equal((paint.match(/background-image/g) ?? []).length, 1);
});
