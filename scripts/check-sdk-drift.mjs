/**
 * Compares the committed OpenAPI spec against the checked-in Fern SDK types and reports
 * required/optional drift. The SDK is generated remotely and cannot be rebuilt in CI, so
 * this is the only guard that the two stay in step.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'fern/openapi/openapi.json'), 'utf-8'));
const typesDir = join(root, 'packages/sdk/src/api/types');

/** Fern renames snake_case wire fields to camelCase in the TypeScript surface. */
function toCamelCase(name) {
  return name.replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
}

/** Field names the interface marks optional, i.e. declared as `name?:`. */
function readOptionalFields(source) {
  const optional = new Set();
  const all = new Set();
  for (const line of source.split('\n')) {
    const match = /^\s{4}(\w+)(\?)?:/.exec(line);
    if (match === null) continue;
    all.add(match[1]);
    if (match[2] === '?') optional.add(match[1]);
  }
  return { optional, all };
}

const available = new Set(readdirSync(typesDir).filter(file => file.endsWith('.ts')));
const problems = [];

for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
  if (schema.type !== 'object' || schema.properties === undefined) continue;
  const file = `${name}.ts`;
  if (!available.has(file)) continue;

  const source = readFileSync(join(typesDir, file), 'utf-8');
  if (!source.includes(`interface ${name}`)) continue;

  const { optional, all } = readOptionalFields(source);
  const required = new Set(schema.required ?? []);

  for (const property of Object.keys(schema.properties)) {
    const field = toCamelCase(property);
    if (!all.has(field)) continue;
    const specRequires = required.has(property);
    const sdkRequires = !optional.has(field);
    if (specRequires !== sdkRequires) {
      problems.push(
        `${name}.${field}: spec says ${specRequires ? 'required' : 'optional'}, ` +
          `SDK says ${sdkRequires ? 'required' : 'optional'}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`SDK is out of step with fern/openapi/openapi.json (${String(problems.length)}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nRegenerate with `fern generate --group ts-sdk` (needs FERN_TOKEN).');
  process.exit(1);
}
console.log('SDK types match the OpenAPI spec.');
