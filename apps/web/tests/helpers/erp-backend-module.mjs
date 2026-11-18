import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the actual selector in Node while keeping its production server-only guard.
function moduleUrl(file, transform = source => source) {
  const source = readFileSync(new URL("../../src/server/bff/" + file, import.meta.url), "utf8").replace('import "server-only"', "");
  const compiled = ts.transpileModule(transform(source), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return "data:text/javascript;base64," + Buffer.from(compiled).toString("base64");
}
const locations = moduleUrl("stock-location-path.ts");
export const { selectErpBackend, erpHealthOrigins,stockLocationPath } = await import(moduleUrl("erp-backend.ts",
  source => source.replace('"./stock-location-path"', JSON.stringify(locations))));
