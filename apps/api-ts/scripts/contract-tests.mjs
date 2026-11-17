import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const api = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.API_TS_TEST_ADMIN_URL) throw Error("API_TS_TEST_ADMIN_URL is required; use a disposable local PostgreSQL administrator");
const executable = process.platform === "win32" ? "erp-next-api.exe" : "erp-next-api";
const target = resolve(root, "target/debug", executable);
function build(features) {
  const result = spawnSync("cargo", ["build", "--locked", "--offline", "-p", "erp-next-api", "--bin", "erp-next-api", ...(features ? ["--features", features] : [])], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
let reference = process.env.API_TS_TEST_RUST_BINARY;
if (!reference) {
  build("migration-reference");
  mkdirSync(resolve(root, "artifacts/typescript-contract"), { recursive: true });
  reference = resolve(root, "artifacts/typescript-contract", executable);
  copyFileSync(target, reference);
}
let gateway = process.env.API_TS_TEST_GATEWAY_BINARY;
if (!gateway) { build(); gateway = target; }
reference = resolve(reference); gateway = resolve(gateway);
if (reference === gateway || !existsSync(reference) || !existsSync(gateway)) throw Error("Contract verification requires distinct reference and production gateway binaries");
function contract(binary) {
  const result = spawnSync(binary, ["openapi"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`OpenAPI export failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
assert.deepEqual(contract(gateway), contract(reference), "Production and reference must expose identical OpenAPI and native MCP inputs");
const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "test/postgres-sales.test.ts"], { cwd: api, env: { ...process.env, API_TS_TEST_RUST_BINARY: reference, API_TS_TEST_GATEWAY_BINARY: gateway }, stdio: "inherit", windowsHide: true });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
