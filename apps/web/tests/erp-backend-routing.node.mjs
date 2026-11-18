import assert from "node:assert/strict";
import { test } from "node:test";
import { selectErpBackend } from "./helpers/erp-backend-module.mjs";

const rust = "http://127.0.0.1:8080", typescript = "http://127.0.0.1:8081";
const environment = { ERP_TYPESCRIPT_API_URL: typescript, ERP_TYPESCRIPT_MODULES: "preferences,registrations,sales,reports" };
const id = "11111111-1111-4111-8111-111111111111";

test("migrated methods permanently select TypeScript, including with legacy flags absent", () => {
  for (const [method, resource] of [["PUT", "/preferences"], ["POST", "/parties"], ["GET", `/products/${id}`], ["PUT", `/tags/${id}`], ["PUT", "/registration-settings/products"], ["POST", `/orders/${id}/confirm`], ["POST", `/proposals/${id}/approve-order`], ["POST", "/commercial/mixed/orders"], ["GET", "/commercial/tables/imported"], ["GET", "/commercial/metrics/orders"], ["PUT", `/opportunities/${id}`], ["GET", "/dashboard"], ["PUT", `/system/custom-reports/${id}`]]) {
    assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript, resource);
  }
  assert.equal(selectErpBackend("PUT", "/preferences", rust, { ...environment, ERP_TYPESCRIPT_MODULES: "sales" }).origin, typescript);
  assert.equal(selectErpBackend("POST", "/orders", rust, { ...environment, ERP_TYPESCRIPT_MODULES: "sales" }).origin, typescript);
  assert.equal(selectErpBackend("PUT", "/preferences", rust, { ERP_TYPESCRIPT_API_URL: typescript }).origin, typescript);
  assert.throws(() => selectErpBackend("PUT", "/preferences", rust, {}));
});

test("saved legacy pricing and its approval use the migrated sales backend", () => {
  for (const [method, resource] of [["GET", `/orders/${id}/pricing`], ["POST", `/orders/${id}/pricing/approve`]]) assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript);
});

test("document previews and email dispatch use the TypeScript backend", () => {
  for (const resource of [`/orders/${id}/email`, `/proposals/${id}/email`, `/receivables/${id}/email`, `/financial-payables/${id}/email`, `/commercial-contracts/${id}/email`, "/financial-report/email"]) {
    for (const method of ["GET", "POST"]) assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript, resource);
  }
  assert.equal(selectErpBackend("POST", `/commercial-contracts/${id}/send-package`, rust, environment).origin, typescript);
});

test("unmigrated routes and unsupported methods stay on their explicit Rust origin", () => {
  for (const [method, resource] of [["GET", `/orders/${id}/document`], ["POST", "/fiscal/nfe"], ["GET", "/receivables"], ["GET", `/products/${id}/catalog`], ["GET", "/products/export"], ["POST", "/preferences"], ["DELETE", `/products/${id}`], ["GET", `/system/custom-reports/${id}`], ["GET", "/commercial/tables/unknown"], ["POST", `/orders/${id}/cancel-completed`]]) {
    assert.equal(selectErpBackend(method, resource, rust, environment).origin, rust, resource);
  }
});

test("enabled routes fail closed on missing or invalid TypeScript configuration", () => {
  for (const url of [undefined, "http://remote.example", "https://user:secret@example.test", "https://example.test/path", "https://example.test?query=1", "https://example.test#fragment"]) {
    assert.throws(() => selectErpBackend("POST", "/orders", rust, { ERP_TYPESCRIPT_MODULES: "sales", ERP_TYPESCRIPT_API_URL: url }));
  }
  for (const modules of ["", "unknown", "sales,sales", "sales,"]) assert.equal(selectErpBackend("POST", "/orders", rust, { ...environment, ERP_TYPESCRIPT_MODULES: modules }).origin, typescript, "Retired flags cannot switch command ownership");
  assert.equal(selectErpBackend("POST", "/orders", rust, { ERP_TYPESCRIPT_MODULES: "sales", ERP_TYPESCRIPT_API_URL: "https://api.internal.example" }).origin, "https://api.internal.example");
});
