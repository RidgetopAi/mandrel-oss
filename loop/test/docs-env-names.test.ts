import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTH_ENV_NAMES } from '../src/auth.js';

/** Name prefixes the README is held to; any other all-caps word is not an env var. */
const PREFIXES = ['MANDREL_', 'CLAUDE_CODE_', 'ANTHROPIC_', 'GH_'];

const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');

function documentedNames(text: string): string[] {
  const found = text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return [...new Set(found.filter((n) => PREFIXES.some((p) => n.startsWith(p))))].sort();
}

describe('loop/README.md env var names', () => {
  it('equals the set auth.ts exports', () => {
    expect(documentedNames(readme)).toEqual([...AUTH_ENV_NAMES].sort());
  });

  it('the detector sees a prefixed name and ignores unrelated ones', () => {
    expect(documentedNames('set GH_TOKEN, not HOME or MY_VAR or XGH_TOKEN')).toEqual(['GH_TOKEN']);
  });
});
