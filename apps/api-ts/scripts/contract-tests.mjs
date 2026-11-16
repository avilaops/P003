import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const api = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.API_TS_TEST_ADMIN_URL) throw Error("API_TS_TEST_ADMIN_URL is required; use a disposable local PostgreSQL administrator");
let binary = process.env.API_TS_TEST_RUST_BINARY;
if (!binary) {
  const build = spawnSync("cargo", ["build", "--locked", "--offline", "-p", "erp-next-api", "--bin", "erp-next-api"], { cwd: root, stdio: "inherit", windowsHide: true });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
  binary = resolve(root, "target/debug", process.platform === "win32" ? "erp-next-api.exe" : "erp-next-api");
}
binary = resolve(binary);
if (!existsSync(binary)) throw Error("Rust contract binary does not exist");
const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "test/postgres-sales.test.ts"], { cwd: api, env: { ...process.env, API_TS_TEST_RUST_BINARY: binary }, stdio: "inherit", windowsHide: true });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
