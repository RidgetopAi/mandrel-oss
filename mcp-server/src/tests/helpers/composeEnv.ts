/**
 * Read the `environment:` map of one compose service by indentation (no YAML dependency:
 * mcp-server declares none). Handles the map form (`KEY: value`) the compose files use.
 * Shared by the TRUST_PROXY contract tests.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
export const readRepoFile = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** Environment of the mandrel-command-backend service in `file` (repo-relative). */
export function backendEnv(file: string): Record<string, string> {
  const lines = readRepoFile(file).split('\n');
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const svc = lines.findIndex((l) => /^ {2}mandrel-command-backend:\s*$/.test(l));
  if (svc < 0) throw new Error(`mandrel-command-backend not found in ${file}`);
  const env: Record<string, string> = {};
  let inEnv = false;
  let envIndent = 0;
  for (const l of lines.slice(svc + 1)) {
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
    if (indentOf(l) <= 2) break;
    if (/^ {4}environment:\s*$/.test(l)) { inEnv = true; envIndent = 4; continue; }
    if (inEnv) {
      if (indentOf(l) <= envIndent) break;
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(l);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
  return env;
}
