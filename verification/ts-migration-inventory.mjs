import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { baselineFile } from './discovery.mjs';
import { buildApp } from '../apps/api-ts/src/app.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

async function registrationHash(directory) {
  const hash = createHash('sha256');
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file.endsWith('.ts')) {
        const relative = path.relative(directory, file).split(path.sep).join('/');
        hash.update(`${relative}\0`).update(await readFile(file)).update('\0');
      }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

// Registration is a routing observation, never proof of functional parity.
export function classifyOperations(routes, app) {
  const operations = new Map();
  for (const route of routes) {
    const url = route.path.replace(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g, ':$1');
    for (const method of route.methods) {
      const key = `${method} ${route.path}`;
      const entry = operations.get(key) ?? {
        method, path: route.path, sources: [],
        status: app.hasRoute({ method, url }) ? 'registered_unverified' : 'native_only',
      };
      entry.sources.push(`${route.file}:${route.line}`);
      operations.set(key, entry);
    }
  }
  return [...operations.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export async function inventory() {
  const app = buildApp({
    pool: { async connect() { throw Error('Migration inventory must not access a database'); } },
    userinfoUrl: 'https://auth.example.invalid/userinfo',
    fetchAuth: async () => { throw Error('Migration inventory must not contact Auth'); },
  });
  try {
    await app.ready();
    const text = await readFile(path.join(root, baselineFile), 'utf8');
    // Frozen list of the former native backend's operations: the migration denominator.
    const baseline = JSON.parse(text).operations.map(item => ({
      path: item.path, methods: [item.method], file: item.legacySources[0]?.split(':')[0] ?? baselineFile, line: Number(item.legacySources[0]?.split(':')[1] ?? 0),
    }));
    const operations = classifyOperations(baseline, app);
    return {
      schemaVersion: 1,
      baselineHash: createHash('sha256').update(text).digest('hex'),
      registrationSourceHash: await registrationHash(path.join(root, 'apps/api-ts/src')),
      scope: 'Frozen baseline of the former native HTTP operations (verification/ts-migration-baseline.json). Excludes TypeScript-only routes, dynamic MCP dispatch and non-HTTP workers.',
      limitation: 'registered_unverified means Fastify has a handler, not that behavior, authorization, persistence or production parity has been verified.',
      counts: {
        total: operations.length,
        nativeOnly: operations.filter(item => item.status === 'native_only').length,
        registeredUnverified: operations.filter(item => item.status === 'registered_unverified').length,
      },
      operations,
    };
  } finally { await app.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await inventory(), null, 2)}\n`);
}
