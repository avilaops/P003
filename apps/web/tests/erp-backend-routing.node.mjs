import assert from "node:assert/strict";
import { test } from "node:test";
import { selectErpBackend } from "./helpers/erp-backend-module.mjs";

const rust = "http://127.0.0.1:8080", typescript = "http://127.0.0.1:8081";
const environment = { ERP_TYPESCRIPT_API_URL: typescript, ERP_TYPESCRIPT_MODULES: "preferences,registrations,sales,reports" };
const id = "11111111-1111-4111-8111-111111111111";

test("explicit migrated methods select TypeScript and rollback can target one module", () => {
  for (const [method, resource] of [["PUT", "/preferences"], ["POST", "/parties"], ["GET", `/products/${id}`], ["PUT", `/tags/${id}`], ["PUT", "/registration-settings/products"], ["POST", `/orders/${id}/confirm`], ["POST", `/proposals/${id}/approve-order`], ["POST", "/commercial/mixed/orders"], ["GET", "/commercial/tables/imported"], ["GET", "/commercial/metrics/orders"], ["PUT", `/opportunities/${id}`], ["GET", "/dashboard"], ["PUT", `/system/custom-reports/${id}`]]) {
    assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript, resource);
  }
  assert.equal(selectErpBackend("PUT", "/preferences", rust, { ...environment, ERP_TYPESCRIPT_MODULES: "sales" }).origin, rust);
  assert.equal(selectErpBackend("POST", "/orders", rust, { ...environment, ERP_TYPESCRIPT_MODULES: "sales" }).origin, typescript);
  assert.equal(selectErpBackend("PUT", "/preferences", rust, {}).origin, rust);
});

test("saved legacy pricing and its approval use the migrated sales backend", () => {
  for (const [method, resource] of [["GET", `/orders/${id}/pricing`], ["POST", `/orders/${id}/pricing/approve`]]) assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript);
});

test("unmigrated routes and unsupported methods stay on their explicit Rust origin", () => {
  for (const [method, resource] of [["GET", `/orders/${id}/document`], ["POST", `/orders/${id}/email`], ["GET", `/proposals/${id}/email`], ["POST", "/fiscal/nfe"], ["GET", "/receivables"], ["GET", `/products/${id}/catalog`], ["GET", "/products/export"], ["POST", "/preferences"], ["DELETE", `/products/${id}`], ["GET", `/system/custom-reports/${id}`], ["GET", "/commercial/tables/unknown"], ["POST", `/orders/${id}/cancel-completed`]]) {
    assert.equal(selectErpBackend(method, resource, rust, environment).origin, rust, resource);
  }
});

test("enabled routes fail closed on missing or invalid TypeScript configuration", () => {
  for (const url of [undefined, "http://remote.example", "https://user:secret@example.test", "https://example.test/path", "https://example.test?query=1", "https://example.test#fragment"]) {
    assert.throws(() => selectErpBackend("POST", "/orders", rust, { ERP_TYPESCRIPT_MODULES: "sales", ERP_TYPESCRIPT_API_URL: url }));
  }
  for (const modules of ["unknown", "sales,sales", "sales,"]) assert.throws(() => selectErpBackend("POST", "/orders", rust, { ...environment, ERP_TYPESCRIPT_MODULES: modules }));
  assert.equal(selectErpBackend("POST", "/orders", rust, { ERP_TYPESCRIPT_MODULES: "sales", ERP_TYPESCRIPT_API_URL: "https://api.internal.example" }).origin, "https://api.internal.example");
});
