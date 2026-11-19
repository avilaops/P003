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

test("pricing inputs, approval, publication and simulation share the TypeScript API", () => {
  for (const line of ["imported", "national"]) {
    for (const [method, path] of [
      ["GET", "/commercial-settings/" + line], ["PUT", "/commercial-settings/" + line], ["POST", "/commercial-settings/" + line + "/preview"],
      ["GET", "/price-tables/" + line], ["GET", "/price-tables/" + line + "/preview"], ["POST", "/price-tables/" + line + "/publish"],
      ["GET", "/product-costs/" + id], ["PUT", "/product-costs/" + id], ["GET", "/financial-categories"], ["GET", "/fixed-expenses"],
      ["POST", "/fixed-expenses"], ["PUT", "/fixed-expenses/" + id], ["GET", "/commercial/approval-settings"], ["PUT", "/commercial/approval-settings"],
      ["GET", "/commercial/tables/" + line], ["POST", "/commercial/simulate"],
    ]) assert.equal(selectErpBackend(method, path, rust, { ERP_TYPESCRIPT_API_URL: typescript }).origin, typescript, method + " " + path);
  }
});

test("saved legacy pricing and its approval use the migrated sales backend", () => {
  for (const [method, resource] of [["GET", `/orders/${id}/pricing`], ["POST", `/orders/${id}/pricing/approve`]]) assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript);
});

test("completed sales cancellations and their history use TypeScript", () => {
  assert.equal(selectErpBackend("POST", `/orders/${id}/cancel-completed`, rust, environment).origin, typescript);
  assert.equal(selectErpBackend("GET", `/orders/${id}/cancellations`, rust, environment).origin, typescript);
});

test("document previews and email dispatch use the TypeScript backend", () => {
  for (const resource of [`/orders/${id}/email`, `/proposals/${id}/email`, `/receivables/${id}/email`, `/financial-payables/${id}/email`, `/commercial-contracts/${id}/email`, `/commercial-contracts/${id}/send-package`, "/financial-report/email"]) {
    for (const method of ["GET", "POST"]) assert.equal(selectErpBackend(method, resource, rust, environment).origin, typescript, resource);
  }
});

test("the eleven complementary order methods, title and proposal origins route to TypeScript", () => {
  for(const [method, suffix] of [["GET","document"],["GET","finance"],["GET","documents"],["POST","documents"],["GET","documents/"+id],["GET","commission"],["PUT","commission"],["GET","cancellations"],["POST","cancel-completed"],["GET","email"],["POST","email"]]) {
    assert.equal(selectErpBackend(method,"/orders/"+id+"/"+suffix,rust,environment).origin,typescript,suffix);
  }
  for(const [method,resource] of [["GET","/receivables/"+id],["POST","/receivables/"+id+"/payments"],["POST","/receivables/"+id+"/reverse-payment"],["GET","/orders/"+id],["GET","/proposals/"+id]]) {
    assert.equal(selectErpBackend(method,resource,rust,environment).origin,typescript,resource);
  }
});

test("wallets, stock and production resolve to their TypeScript owners", () => {
  for (const [method, resource, module] of [
    ["GET", "/receivables", "finance"], ["GET", "/financial-accounts", "finance"],
    ["GET", "/warehouses", "inventory"], ["POST", "/stock/periods/close", "inventory"],
    ["GET", "/production/orders", "inventory"],
  ]) assert.deepEqual(selectErpBackend(method, resource, rust, environment), { origin: typescript, backend: "typescript", module });
});

test("product catalog sheet, private photos and catalog publication use TypeScript", () => {
  for (const [method, resource] of [["GET", `/products/${id}/catalog`], ["PUT", `/products/${id}/catalog`], ["GET", `/products/${id}/media/${id}`], ["GET", "/catalog-publication"], ["POST", "/catalog-publication"], ["GET", "/products/catalog-pending"]]) {
    assert.deepEqual(selectErpBackend(method, resource, rust, environment), { origin: typescript, backend: "typescript", module: "registrations" }, method + " " + resource);
  }
});

test("unmigrated routes and unsupported methods stay on their explicit Rust origin", () => {
  for (const [method, resource] of [["PUT", `/orders/${id}/document`], ["POST", "/fiscal/nfe"], ["DELETE", "/receivables"], ["DELETE", `/products/${id}/catalog`], ["PUT", `/products/${id}/media/${id}`], ["GET", "/products/export"], ["POST", "/preferences"], ["DELETE", `/products/${id}`], ["GET", `/system/custom-reports/${id}`], ["GET", "/commercial/tables/unknown"], ["GET", `/orders/${id}/cancel-completed`]]) {
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

test("motor de relatórios (G3) usa a API TypeScript e recusa métodos fora do contrato", () => {
  for (const [method, resource] of [["GET", "/reports/sources"], ["POST", "/reports/preview"], ["GET", `/reports/definitions/${id}/run`],
    ["GET", `/reports/definitions/${id}/schedules`], ["POST", `/reports/definitions/${id}/schedules`], ["PUT", `/reports/schedules/${id}`], ["GET", `/reports/runs/${id}/file`]]) {
    const selected = selectErpBackend(method, resource, rust, environment);
    assert.equal(selected.origin, typescript, `${method} ${resource}`);
    assert.equal(selected.module, "reports");
  }
  for (const [method, resource] of [["DELETE", `/reports/schedules/${id}`], ["POST", "/reports/sources"], ["GET", "/reports/preview"], ["GET", "/reports/definitions/x/run"]]) {
    assert.equal(selectErpBackend(method, resource, rust, environment).backend, "rust", `${method} ${resource} não é rota do motor`);
  }
});
