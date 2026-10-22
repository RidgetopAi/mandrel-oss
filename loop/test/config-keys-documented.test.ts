import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/settings.js';

/** The guide whose key table is held to the loader. */
const GUIDE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'loop', 'runtime-setup.md');
/** How a repository entry's name is written in a documented key. */
const RECORD_PLACEHOLDER = '<tag>';

interface ZodNode {
  _def: { typeName: string; innerType?: ZodNode; schema?: ZodNode; valueType?: ZodNode; shape?: () => Record<string, ZodNode> };
}

/** Every key the loader accepts, as dotted paths: leaves, plus `repos.<tag>` for the record. */
export function acceptedKeys(node: ZodNode, prefix = ''): string[] {
  const d = node._def;
  switch (d.typeName) {
    case 'ZodDefault':
    case 'ZodOptional':
      return acceptedKeys(d.innerType!, prefix);
    case 'ZodEffects':
      return acceptedKeys(d.schema!, prefix);
    case 'ZodRecord': {
      const entry = `${prefix}.${RECORD_PLACEHOLDER}`;
      return [entry, ...acceptedKeys(d.valueType!, entry)];
    }
    case 'ZodObject':
      return Object.entries(d.shape!()).flatMap(([k, v]) => acceptedKeys(v, prefix ? `${prefix}.${k}` : k));
    default:
      return [prefix];
  }
}

/** Keys named in the first cell of a table row, written as `key`. */
export function documentedKeys(markdown: string): string[] {
  return [...markdown.matchAll(/^\|\s*`([^`|]+)`\s*\|/gm)].map((m) => m[1]);
}

const loaderKeys = [...new Set(acceptedKeys(configSchema as unknown as ZodNode))].sort();
/** Top-level keys of the loader; the stale-row check only applies to rows under these. */
const KEY_ROOTS = new Set(loaderKeys.map((k) => k.split('.')[0]));
const guideKeys = documentedKeys(readFileSync(GUIDE, 'utf8'));

describe('docs/loop/runtime-setup.md documents the config loader keys', () => {
  it.each(loaderKeys)('documents %s', (key) => {
    expect(guideKeys, `config key "${key}" is accepted by loop/src/settings.ts but has no row in docs/loop/runtime-setup.md`).toContain(key);
  });

  it('has no row for a key the loader does not accept', () => {
    const stale = guideKeys.filter((k) => KEY_ROOTS.has(k.split('.')[0]) && !loaderKeys.includes(k));
    expect(stale, `rows in docs/loop/runtime-setup.md for keys the loader rejects: ${stale.join(', ')}`).toEqual([]);
  });

  it('derives the expected shape from the schema', () => {
    expect(loaderKeys).toContain('mandrel.url');
    expect(loaderKeys).toContain('repos.<tag>.gateTimeoutMinutes');
    expect(loaderKeys).toContain('notify.webhookUrlEnv');
    expect(loaderKeys).toContain('workdir');
  });

  it('the row detector reads a backticked first cell only', () => {
    expect(documentedKeys('| `a.b` | x |\n| plain | `c` |\n')).toEqual(['a.b']);
  });
});
