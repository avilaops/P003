import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateOpenApi } from './consumer/openapi-validation.mjs';

// Reads a self-contained OpenAPI document and validates it. Shared by the client generator and the consumer checks.
export async function readOpenApi(file) {
  const bytes = await readFile(file);
  if (bytes.length > 20 * 1024 * 1024) throw new Error('INVALID_OPENAPI');
  const document = JSON.parse(bytes);
  if (!/^3\.[01]\.\d+$/.test(document.openapi ?? '') || !document.info || !document.paths
      || Array.isArray(document.paths) || typeof document.paths !== 'object') throw new Error('INVALID_OPENAPI');
  // The contract is self-contained: the type generator must never fetch refs.
  function check(value) {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value && (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/'))) throw new Error('INVALID_OPENAPI_EXTERNAL_REF');
    for (const item of Object.values(value)) check(item);
  }
  check(document);
  await validateOpenApi(document);
  return { document, sha256: createHash('sha256').update(bytes).digest('hex') };
}
