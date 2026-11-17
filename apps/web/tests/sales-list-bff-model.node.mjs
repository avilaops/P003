import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, after } from "node:test";
import ts from "typescript";
const previousTypescriptOrigin = process.env.ERP_TYPESCRIPT_API_URL;
process.env.ERP_TYPESCRIPT_API_URL = "http://127.0.0.1:8081";
after(() => { if (previousTypescriptOrigin === undefined) delete process.env.ERP_TYPESCRIPT_API_URL; else process.env.ERP_TYPESCRIPT_API_URL = previousTypescriptOrigin; });

const tenant = "11111111-1111-4111-8111-111111111111";
const uri = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const session = uri(`export const currentSession=async()=>({tenantId:"${tenant}",accessToken:"fixture"});export const currentIdentitySession=currentSession;export const erpConfiguration=()=>({origin:"http://fixture.local",api:"http://backend.local"});`);
const source = readFileSync(new URL("../src/server/bff/erp-proxy.ts", import.meta.url), "utf8")
  .replace('import "server-only"', "").replace('"@/server/bff/erp-backend"', JSON.stringify(new URL("./helpers/erp-backend-module.mjs", import.meta.url).href))
  .replace('"@/server/auth/erp-session"', JSON.stringify(session))
  .replace('"@/lib/api/local-fiscal-origin"', JSON.stringify(new URL("../src/lib/api/local-fiscal-origin.ts", import.meta.url).href));
const { forwardErp } = await import(uri(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));

for (const resource of ["/orders", "/proposals"]) {
  test(`${resource} • filtros e atualização chegam à API com empresa da sessão`, async () => {
    const previous = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json({ tenantId: tenant, data: [], total: 42 }); };
    try {
      const response = await forwardErp(new Request(`http://fixture.local${resource}?status=draft&sort=updated&limit=5&offset=25&q=Academia`), resource);
      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { status: "draft", sort: "updated", limit: "5", offset: "25", q: "Academia" });
      assert.equal(calls[0].init.headers.get("x-tenant-id"), tenant);
      assert.match(response.headers.get("cache-control"), /no-store/);
    } finally { globalThis.fetch = previous; }
  });

  test(`${resource} • recusa filtros duplicados e troca de empresa pela consulta`, async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { throw Error("Consulta inesperada"); };
    try {
      for (const query of ["sort=updated&sort=created", "tenantId=outra", "status=draft&status=confirmed"]) {
        assert.equal((await forwardErp(new Request(`http://fixture.local${resource}?${query}`), resource)).status, 400);
      }
    } finally { globalThis.fetch = previous; }
  });
}
