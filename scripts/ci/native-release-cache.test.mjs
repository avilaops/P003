import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCache, verifyCache } from './native-release-cache.mjs';

const meta = { inputHash: 'a'.repeat(64), sourceSha: 'b'.repeat(40), runId: '123', platform: 'linux-x64', epoch: '2026-11-17', digest: `sha256:${'c'.repeat(64)}` };
const contract = { openapi: '3.1.0', paths: { '/health': {} } };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({
    'artifacts/typescript-contract/erp-next-api': 'reference',
    'target/debug/erp-next-api': 'gateway',
    'artifacts/contracts/candidate.json': JSON.stringify(contract),
    'artifacts/contracts/company.json': JSON.stringify({ company: true }),
  })) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); }
  const dir = prepareCache(root, meta);
  return { root, dir, inspectImage: () => true, readContract: () => contract };
}
test('reuses only an intact fully validated component and its exact digest', t => {
  const f = fixture(t);
  const result = verifyCache(f.dir, meta, f);
  assert.equal(result.digest, meta.digest);
  assert.equal(result.sourceSha, meta.sourceSha);
});
test('changed binary is rejected before any cached executable runs', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'gateway-api'), 'changed');
  f.readContract = () => assert.fail('corrupt executable must not run');
  assert.throws(() => verifyCache(f.dir, meta, f), /integrity/);
});
test('changed native inputs, platform and epoch require full validation', t => {
  const f = fixture(t);
  for (const change of [{ inputHash: 'd'.repeat(64) }, { platform: 'linux-arm64' }, { epoch: '2026-11-24' }]) {
    assert.throws(() => verifyCache(f.dir, { ...meta, ...change }, f), /identity/);
  }
});
test('missing image or incompatible OpenAPI cannot be reused', t => {
  const f = fixture(t);
  assert.throws(() => verifyCache(f.dir, meta, { ...f, inspectImage: () => false }), /image/);
  assert.throws(() => verifyCache(f.dir, meta, { ...f, readContract: () => ({ paths: {} }) }), /contract/);
});
test('receipt cannot redirect verification to other files or images', t => {
  const f = fixture(t);
  const receipt = JSON.parse(readFileSync(join(f.dir, 'receipt.json')));
  receipt.files['../../foreign'] = 'a'.repeat(64);
  writeFileSync(join(f.dir, 'receipt.json'), JSON.stringify(receipt));
  assert.throws(() => verifyCache(f.dir, meta, f), /files/);
  delete receipt.files['../../foreign']; receipt.digest = 'latest';
  writeFileSync(join(f.dir, 'receipt.json'), JSON.stringify(receipt));
  assert.throws(() => verifyCache(f.dir, meta, f), /receipt/);
});
test('symbolic links are rejected even when their contents match', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const path = join(f.dir, 'reference-api');
  rmSync(path); symlinkSync(join(f.root, 'artifacts/typescript-contract/erp-next-api'), path);
  assert.throws(() => verifyCache(f.dir, meta, f), /regular file/);
});
