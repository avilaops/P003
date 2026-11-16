import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] || "artifacts/api-ts");
const entry = resolve(directory, "dist/server.js");
assert.ok(existsSync(entry), "Production server entry must exist");
assert.equal(existsSync(resolve(directory, "node_modules/tsx")), false, "Production package must not depend on the development TS runner");
const lease = createServer();
await new Promise(resolve => lease.listen(0, "127.0.0.1", resolve));
const address = lease.address();
assert.ok(address && typeof address !== "string");
await new Promise((resolve, reject) => lease.close(error => error ? reject(error) : resolve()));
const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
Object.assign(env, { NODE_ENV: "production", DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused", AUTH_ISSUER: "http://127.0.0.1:1", API_TS_HOST: "127.0.0.1", API_TS_PORT: String(address.port) });
const child = spawn(process.execPath, [entry], { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "", exited = false, failure;
child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-2000); });
child.stderr.on("data", chunk => { output = (output + String(chunk)).slice(-2000); });
const done = new Promise(resolve => { child.once("error", error => { failure = error; exited = true; resolve(); }); child.once("exit", () => { exited = true; resolve(); }); });
try {
  let live = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (exited) throw failure || Error(`Packaged server exited: ${output}`);
    try { const response = await fetch(`http://127.0.0.1:${address.port}/health/live`, { signal: AbortSignal.timeout(300) }); live = response.ok; await response.body?.cancel(); } catch { /* Only probe the owned child. */ }
    if (live) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(live, `Packaged server must start without TypeScript tooling: ${output}`);
  const unavailable = await fetch(`http://127.0.0.1:${address.port}/health/ready`, { signal: AbortSignal.timeout(6000) });
  assert.equal(unavailable.status, 503, "Unavailable database must fail readiness");
  assert.deepEqual(await unavailable.json(), { status: "unavailable" });
  console.log("TypeScript production package • startup and failed-database readiness verified");
} finally {
  if (!exited) child.kill("SIGTERM");
  const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
  await done;
  clearTimeout(timer);
}
