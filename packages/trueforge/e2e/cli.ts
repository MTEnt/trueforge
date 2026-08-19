/**
 * E2E CLI entry: loads `e2e/.env` (real environment variables win). Cases are
 * registered in a follow-up; this file exists so `pnpm e2e` and typecheck have
 * a program.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const preexisting = { ...process.env };
  process.loadEnvFile(path);
  Object.assign(process.env, preexisting);
}

function parseOnlyFilter(argv: string[]): string | undefined {
  const idx = argv.indexOf('--only');
  const value = idx !== -1 ? argv[idx + 1] : undefined;
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

function main(): void {
  loadDotEnv(resolve(HERE, '.env'));
  const filter = parseOnlyFilter(process.argv);
  if (filter !== undefined) {
    console.log(`E2E filter: ${filter}`);
  }
  console.log('E2E CLI wired; cases are not registered yet.');
}

try {
  main();
} catch (err: unknown) {
  console.error(err);
  process.exitCode = 1;
}
