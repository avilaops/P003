import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOpenApi } from './openapi-reader.mjs';

// Validates the contract generated from the TypeScript API (apps/api-ts/openapi.json) as OpenAPI 3.x.
// Requires the dependencies of scripts/contracts/consumer (installed by the API workflow).
const file = resolve(fileURLToPath(new URL('../../apps/api-ts/openapi.json', import.meta.url)));
const { document, sha256 } = await readOpenApi(file);
const operations = Object.values(document.paths).reduce((sum, item) => sum + Object.keys(item).length, 0);
console.log(`OpenAPI ${document.openapi} válido: ${Object.keys(document.paths).length} caminhos, ${operations} operações, sha256 ${sha256}`);
