import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ContractSignatureValidationError, contractSignatureValidatorFromEnv } from "../src/modules/contract-signatures/validator.js";

const fixture = (name: string) => fileURLToPath(new URL("../../api/tests/fixtures/contract-wire/" + name, import.meta.url));
const roots = fileURLToPath(new URL("../../../deploy/fiscal/icp-brasil-roots.pem", import.meta.url));
const offline = (e: unknown) => e instanceof ContractSignatureValidationError && e.statusCode === 503;

test("disabled configuration and unapproved ICP anchors fail closed", () => {
  assert.throws(() => contractSignatureValidatorFromEnv({}), offline);
  const env = { ERP_CONTRACT_VALIDATOR_URL: "https://127.0.0.1", ERP_CONTRACT_VALIDATOR_TLS_CA_FILE: fixture("tls-test-ca.pem"),
    ERP_CONTRACT_VALIDATOR_ROOTS_FILE: fixture("tls-test-ca.pem") };
  assert.throws(() => contractSignatureValidatorFromEnv(env), offline);
});

test("the client interoperates with Python over private TLS and rejects redirects and unsigned responses", { timeout: 60_000 }, async t => {
  const raw = JSON.parse(readFileSync(fixture("preflight.json"), "utf8"));
  const temp = mkdtempSync(join(tmpdir(), "avila-validator-wire-"));
  const keyring = join(temp, "keys.json");
  writeFileSync(keyring, JSON.stringify({ schemaVersion: "avila-validator-keys/1", keys: { [raw.keyId]: raw.keyBase64 } }), { mode: 0o600 });
  t.after(() => { unlinkSync(keyring); rmdirSync(temp); });
  for (const mode of ["normal", "wrong_mac", "redirect", "oversize"]) {
    const python = process.env.ERP_CONTRACT_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, ["-u", fixture("https_fixture.py"), mode],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const output = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    try {
      const [port] = await Promise.race([
        once(output, "line"), closed.then(() => { throw new Error("Python TLS fixture exited before listening"); }),
      ]);
      assert.match(port, /^\d+$/);
      const env = { ERP_CONTRACT_VALIDATOR_URL: "https://127.0.0.1:" + port, ERP_CONTRACT_VALIDATOR_TLS_CA_FILE: fixture("tls-test-ca.pem"),
        ERP_CONTRACT_VALIDATOR_KEY_ID: raw.keyId, ERP_CONTRACT_VALIDATOR_KEYRING_FILE: keyring, ERP_CONTRACT_VALIDATOR_ROOTS_FILE: roots };
      const context = { tenantId: raw.tenantId, envelopeId: raw.envelopeId, documentId: raw.documentId };
      const base = Buffer.from(raw.parts.base, "base64");
      const send = (config = env) => contractSignatureValidatorFromEnv(config).preflight(context, base);
      if (mode === "normal") {
        const result = await send();
        assert.equal(result.verdict, "accepted");
        assert.equal(result.trustBundleSha256, raw.trustBundleSha256);
        await assert.rejects(send({ ...env, ERP_CONTRACT_VALIDATOR_TLS_CA_FILE: roots }), offline);
      } else await assert.rejects(send(), offline);
    } catch (e) {
      if (typeof e === "object" && e && "code" in e && e.code === "ENOENT") {
        t.skip("Python 3 required for the cross-language HTTPS fixture");
        return;
      }
      throw e;
    } finally {
      output.close();
      child.kill();
      await closed.catch(() => {});
    }
  }
});
