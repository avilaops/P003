import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const tenant = "11111111-1111-4111-8111-111111111111";
const uri = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const session = uri(`export const currentSession=async()=>({tenantId:"${tenant}",accessToken:"session-token"});export const currentIdentitySession=currentSession;export const erpConfiguration=()=>({origin:"http://fixture.local",api:"http://rust.local"});`);
const source = readFileSync(new URL("../src/server/bff/erp-proxy.ts", import.meta.url), "utf8")
  .replace('import "server-only"', "")
  .replace('"@/server/auth/erp-session"', JSON.stringify(session))
  .replace('"@/server/bff/erp-backend"', JSON.stringify(new URL("./helpers/erp-backend-module.mjs", import.meta.url).href))
  .replace('"@/lib/api/local-fiscal-origin"', JSON.stringify(new URL("../src/lib/api/local-fiscal-origin.ts", import.meta.url).href));
const { forwardErp } = await import(uri(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));

test("BFF selects one backend per module and never retries commands on Rust", async () => {
  const previousFetch = globalThis.fetch;
  const previous = { ERP_TYPESCRIPT_MODULES: process.env.ERP_TYPESCRIPT_MODULES, ERP_TYPESCRIPT_API_URL: process.env.ERP_TYPESCRIPT_API_URL };
  const calls = [];
  const command = resource => new Request(`http://fixture.local${resource}`, { method: "POST", headers: { origin: "http://fixture.local", "content-type": "application/json", "x-tenant-id": tenant, authorization: "Bearer forged", "if-match": '"7"', "idempotency-key": "same-command" }, body: '{"value":9007199254740993}' });
  try {
    process.env.ERP_TYPESCRIPT_MODULES = "preferences,registrations,sales,reports";
    process.env.ERP_TYPESCRIPT_API_URL = "http://127.0.0.1:8081";
    globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), init }); return new Response('{"ok":true}', { status: 201, headers: { etag: '"8"', "idempotency-replayed": "true", "x-request-id": "fixture-request", "x-erp-backend": "typescript" } }); };
    const response = await forwardErp(command("/orders"), "/orders");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-erp-backend"), "typescript");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, "http://127.0.0.1:8081");
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer session-token");
    assert.equal(calls[0].init.headers.get("x-tenant-id"), tenant);
    assert.equal(calls[0].init.headers.get("if-match"), '"7"');
    assert.equal(calls[0].init.headers.get("idempotency-key"), "same-command");
    assert.equal(calls[0].init.body, '{"value":9007199254740993}');
    assert.equal(calls[0].init.redirect, "error");
    for (const [key, value] of [["etag", '"8"'], ["idempotency-replayed", "true"], ["x-request-id", "fixture-request"]]) assert.equal(response.headers.get(key), value);
    for (const resource of ["/preferences", "/parties", "/orders", "/dashboard"]) {
      calls.length = 0;
      assert.equal((await forwardErp(new Request(`http://fixture.local${resource}`), resource)).status, 201);
      assert.equal(calls[0].url.origin, "http://127.0.0.1:8081");
    }
    calls.length = 0;
    globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), init }); throw Error("Lost response after write"); };
    assert.equal((await forwardErp(command("/orders"), "/orders")).status, 503);
    assert.equal(calls.length, 1, "Lost command response must not trigger another backend call");
    assert.equal(calls[0].url.origin, "http://127.0.0.1:8081");
    calls.length = 0;
    globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json({ title: "Backend conflict" }, { status: 409 }); };
    assert.equal((await forwardErp(command("/orders"), "/orders")).status, 409);
    assert.equal(calls.length, 1);
    process.env.ERP_TYPESCRIPT_MODULES = "preferences,reports";
    calls.length = 0;
    await forwardErp(command("/orders"), "/orders");
    assert.equal(calls[0].url.origin, "http://127.0.0.1:8081", "Retired flags cannot restore Rust business handlers");
    process.env.ERP_TYPESCRIPT_MODULES = "preferences,registrations,sales,reports";
    calls.length = 0;
    for (const [resource, query] of [["/receivables", "limit=12"], ["/stock/reports", "dataset=stock_position"], ["/warehouses", "q=central"]]) {
      calls.length = 0;
      await forwardErp(new Request("http://fixture.local" + resource + "?" + query), resource);
      assert.equal(calls[0].url.origin, "http://127.0.0.1:8081");
      assert.equal(calls[0].url.searchParams.toString(), query);
    }
    calls.length = 0;
    await forwardErp(new Request("http://fixture.local/users"), "/users");
    assert.equal(calls[0].url.origin, "http://rust.local");
    delete process.env.ERP_TYPESCRIPT_API_URL;
    calls.length = 0;
    assert.equal((await forwardErp(command("/orders"), "/orders")).status, 503);
    assert.equal(calls.length, 0, "Missing enabled backend must fail before sending a command");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("BFF sends only the product finishes GET and its single IDs filter to TypeScript", async () => {
  const previousFetch = globalThis.fetch;
  const previousOrigin = process.env.ERP_TYPESCRIPT_API_URL;
  const resource = "/products/finishes";
  const ids = "aa000000-0000-3000-2000-000000000001,bb000000-0000-3000-2000-000000000002";
  const request = (query, method = "GET", signal) => new Request(`http://fixture.local${resource}${query}`, {
    method, signal, headers: { authorization: "Bearer forged", "x-tenant-id": "forged" },
  });
  const calls = [];
  try {
    process.env.ERP_TYPESCRIPT_API_URL = "http://127.0.0.1:8081";
    globalThis.fetch = async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json({ tenantId: tenant, data: [], missingIds: ids.split(",") });
    };
    const controller = new AbortController();
    const response = await forwardErp(request(`?ids=${encodeURIComponent(ids)}`, "GET", controller.signal), resource);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.deepEqual(await response.json(), { tenantId: tenant, data: [], missingIds: ids.split(",") });
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url.origin + url.pathname, "http://127.0.0.1:8081/api/v1/products/finishes");
    assert.deepEqual([...url.searchParams], [["ids", ids]]);
    assert.equal(init.cache, "no-store");
    assert.equal(init.headers.get("authorization"), "Bearer session-token");
    assert.equal(init.headers.get("x-tenant-id"), tenant);
    controller.abort();
    assert.equal(init.signal.aborted, true);

    for (const query of ["", `?ids=${ids}&ids=${ids}`, `?ids=${ids}&extra=1`]) {
      assert.equal((await forwardErp(request(query), resource)).status, 400);
    }
    assert.equal((await forwardErp(request(`?ids=${ids}`, "PUT"), resource)).status, 405);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOrigin === undefined) delete process.env.ERP_TYPESCRIPT_API_URL;
    else process.env.ERP_TYPESCRIPT_API_URL = previousOrigin;
  }
});
