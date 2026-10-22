import { readFileSync } from 'node:fs';

// package.json sits one level above both src/ and dist/, so the same relative URL resolves
// whether the CLI runs from the compiled build or under a TypeScript runner.
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);

/** The `version` field of loop/package.json — the single source of the CLI's version. */
export function readVersion(packageJsonUrl: URL = PACKAGE_JSON_URL): string {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`no string "version" field in ${packageJsonUrl.pathname}`);
  }
  return version;
}
