import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the actual selector in Node while keeping its production server-only guard.
const source = readFileSync(new URL("../../src/server/bff/erp-backend.ts", import.meta.url), "utf8").replace('import "server-only"', "");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
export const { selectErpBackend, erpHealthOrigins, salesPolicyResource } = await import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
