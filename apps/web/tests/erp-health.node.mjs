import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/app/api/health/route.ts", import.meta.url), "utf8")
  .replace('"@/server/bff/erp-backend"', JSON.stringify(new URL("./helpers/erp-backend-module.mjs", import.meta.url).href));
const { GET } = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

test("public health requires every enabled private backend and never discloses its origin", async () => {
  const keys = ["ERP_API_URL", "ERP_TYPESCRIPT_API_URL", "ERP_TYPESCRIPT_MODULES"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]])), previousFetch = globalThis.fetch;
  const calls = [];
  let tsReady = true;
  try {
    process.env.ERP_API_URL = "http://127.0.0.1:8080";
    process.env.ERP_TYPESCRIPT_API_URL = "http://127.0.0.1:8081";
    process.env.ERP_TYPESCRIPT_MODULES = "sales";
    globalThis.fetch = async url => { calls.push(String(url)); return Response.json({ status: String(url).includes(":8081/") && !tsReady ? "unavailable" : "ready" }); };
    const ready = await GET();
    assert.equal(ready.status, 200);
    assert.deepEqual(new Set(calls), new Set(["http://127.0.0.1:8080/health/ready", "http://127.0.0.1:8081/health/ready"]));
    tsReady = false;
    const unavailable = await GET();
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.text()).includes("127.0.0.1"), false);
    process.env.ERP_TYPESCRIPT_MODULES = "";
    calls.length = 0;
    assert.equal((await GET()).status, 200);
    assert.deepEqual(calls, ["http://127.0.0.1:8080/health/ready"]);
    process.env.ERP_TYPESCRIPT_MODULES = "sales";
    delete process.env.ERP_TYPESCRIPT_API_URL;
    calls.length = 0;
    assert.equal((await GET()).status, 503);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
