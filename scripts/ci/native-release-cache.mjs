import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sources = {
  'reference-api': 'artifacts/typescript-contract/erp-next-api',
  'gateway-api': 'target/debug/erp-next-api',
  'contracts/candidate.json': 'artifacts/contracts/candidate.json',
  'contracts/company.json': 'artifacts/contracts/company.json',
};
const files = Object.keys(sources).sort();
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const checksum = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function regular(path) {
  assert(lstatSync(path).isFile(), 'cache entry must be a regular file');
}
function identity(meta) {
  assert(/^[a-f0-9]{64}$/.test(meta.inputHash) && /^[a-f0-9]{40}$/.test(meta.sourceSha), 'invalid cache receipt');
  assert(/^\d+$/.test(meta.runId) && digestPattern.test(meta.digest), 'invalid cache receipt');
  assert(/^[a-z0-9-]+$/.test(meta.platform) && /^\d{4}-\d{2}-\d{2}$/.test(meta.epoch), 'invalid cache receipt');
}
export function prepareCache(root, meta, { stripBinary = () => {} } = {}) {
  identity(meta);
  const dir = resolve(root, 'artifacts/native-release-cache');
  assert(dir.startsWith(`${resolve(root)}${sep}`), 'cache must stay inside workspace');
  // Discard restored entries before writing, including any invalid links; rm does not follow links.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'contracts'), { recursive: true });
  const hashes = {};
  for (const file of files) {
    const source = join(root, sources[file]);
    regular(source);
    const target = join(dir, file);
    copyFileSync(source, target);
    if (file.endsWith('-api')) { stripBinary(target); chmodSync(target, 0o755); }
    hashes[file] = checksum(target);
  }
  writeFileSync(join(dir, 'receipt.json'), `${JSON.stringify({ version: 1, fullChecks: true, ...meta, files: hashes }, null, 2)}\n`);
  return dir;
}
export function verifyCache(dir, expected, { inspectImage, readContract }) {
  assert(lstatSync(dir).isDirectory() && lstatSync(join(dir, 'contracts')).isDirectory(), 'cache directories must be regular directories');
  regular(join(dir, 'receipt.json'));
  const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
  identity(receipt);
  assert(receipt.version === 1 && receipt.fullChecks === true, 'invalid cache receipt');
  for (const field of ['inputHash', 'platform', 'epoch']) assert.equal(receipt[field], expected[field], 'cache identity changed');
  assert.deepEqual(Object.keys(receipt.files).sort(), files, 'invalid cache files');
  for (const file of files) {
    regular(join(dir, file));
    assert.equal(checksum(join(dir, file)), receipt.files[file], 'cache integrity failed');
  }
  const candidate = JSON.parse(readFileSync(join(dir, 'contracts/candidate.json'), 'utf8'));
  assert(candidate.openapi && candidate.paths, 'invalid cached contract');
  JSON.parse(readFileSync(join(dir, 'contracts/company.json'), 'utf8'));
  for (const binary of ['reference-api', 'gateway-api']) {
    assert.deepEqual(readContract(join(dir, binary)), candidate, 'cached contract is incompatible');
  }
  assert(inspectImage(receipt.digest), 'cached image is unavailable');
  return receipt;
}
function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, windowsHide: true });
  assert(!result.error && result.status === 0, `native cache command failed: ${file}`);
  return result.stdout;
}
function metadata() {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return {
    inputHash: process.env.NATIVE_INPUT_HASH,
    platform: `${process.platform}-${process.arch}-${process.env.ImageOS || 'runner'}`,
    epoch: monday.toISOString().slice(0, 10),
    sourceSha: process.env.SOURCE_SHA,
    runId: process.env.GITHUB_RUN_ID,
    digest: process.env.NATIVE_DIGEST,
  };
}
function output(key, value) {
  assert(!/[\r\n]/.test(value), 'invalid workflow output');
  appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
function evidence(root, receipt, reused) {
  mkdirSync(join(root, 'artifacts/contracts'), { recursive: true });
  const proof = { reused, sourceSha: process.env.SOURCE_SHA, nativeSourceSha: receipt.sourceSha, nativeRunId: receipt.runId, inputHash: receipt.inputHash, digest: receipt.digest };
  writeFileSync(join(root, 'artifacts/contracts/native-reuse.json'), `${JSON.stringify(proof, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nAPI nativa • ${reused ? 'reutilizada' : 'validação completa'}\n\nRevisão nativa: ${receipt.sourceSha}\n\nImagem: ${receipt.digest}\n`);
}
function main(mode) {
  const root = process.cwd();
  const meta = metadata();
  if (mode === 'key') {
    assert(/^[a-f0-9]{64}$/.test(meta.inputHash), 'native inputs are required');
    output('input_hash', meta.inputHash);
    output('prefix', `native-release-v1-${meta.platform}-${meta.epoch}-${meta.inputHash}-`);
    return;
  }
  if (mode === 'save') {
    prepareCache(root, meta, { stripBinary: path => command('strip', ['--strip-debug', path]) });
    evidence(root, meta, false);
    return;
  }
  assert.equal(mode, 'restore');
  try {
    const dir = join(root, 'artifacts/native-release-cache');
    const receipt = verifyCache(dir, meta, {
      readContract: path => JSON.parse(command(path, ['openapi'])),
      inspectImage: digest => { command('docker', ['manifest', 'inspect', `ghcr.io/avilaops/erp-next-api@${digest}`]); return true; },
    });
    for (const file of ['candidate.json', 'company.json']) {
      mkdirSync(join(root, 'artifacts/contracts'), { recursive: true });
      copyFileSync(join(dir, 'contracts', file), join(root, 'artifacts/contracts', file));
    }
    evidence(root, receipt, true);
    output('reference', join(dir, 'reference-api'));
    output('gateway', join(dir, 'gateway-api'));
    output('digest', receipt.digest);
    output('reuse', 'true');
  } catch {
    // A cache is optional. Missing, corrupt, expired or incompatible entries run the full gate.
    console.log('Native cache unavailable or invalid • using full validation.');
    output('reuse', 'false');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]);
