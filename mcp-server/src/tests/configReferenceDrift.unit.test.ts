/**
 * The settings reference (docs/reference/configuration.md) is GENERATED from the env-helper calls in
 * src/config/*.ts by scripts/gen-config-reference.ts. This test is the gate that keeps it honest:
 *
 *   - it fails when the committed file differs from a fresh run of the generator (a setting was
 *     added, removed, re-defaulted or re-documented without `npm run docs:config`);
 *   - it counts the settings a SECOND way (a plain-text scan, not the generator's TypeScript parse)
 *     and fails if the document lists a different number;
 *   - it fails when any row lacks a type, a default or a plain-language description.
 *
 * Run alone:  npx vitest run src/tests/configReferenceDrift.unit.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const GENERATOR = path.resolve(__dirname, '../../scripts/gen-config-reference.ts');

interface Generator {
  CONFIG_DIR: string;
  REFERENCE_PATH: string;
  ESSENTIALS: Array<{ name: string }>;
  ALLOWED_VALUES: Record<string, string[]>;
  generateReference: () => string;
  collectSettings: () => Array<{ name: string; type: string; defaultText: string; description: string }>;
  descriptionProblem: (d: string) => string | null;
}

async function loadGenerator(): Promise<Generator> {
  // Loaded by computed path: scripts/ sits outside the build's rootDir (src), so a static import
  // would break `tsc`. vitest resolves it at run time.
  return (await import(/* @vite-ignore */ GENERATOR)) as Generator;
}

/**
 * A second, deliberately simple way to count the settings: text patterns over the config sources,
 * no TypeScript parse. `env<Helper>(` (optionally with a generic) whose first argument is a quoted
 * MANDREL_ name or a file-level constant holding one, plus every name passed to envIsSet(...).
 */
function namesByTextScan(configDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(configDir).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(configDir, file), 'utf8');
    for (const m of src.matchAll(/\benv[A-Za-z]*(?:<[^>()]*>)?\(\s*(['"])(MANDREL_[A-Z0-9_]+)\1/g)) names.add(m[2]);
    for (const m of src.matchAll(/\benv[A-Za-z]*(?:<[^>()]*>)?\(\s*([A-Z][A-Z0-9_]*)\s*[,)]/g)) {
      const def = new RegExp(`(?:const|let)\\s+${m[1]}\\b[^=]*=\\s*(['"])(MANDREL_[A-Z0-9_]+)\\1`).exec(src);
      if (def) names.add(def[2]);
    }
    for (const m of src.matchAll(/\benvIsSet\(([^)]*)\)/g)) {
      for (const n of m[1].matchAll(/(['"])(MANDREL_[A-Z0-9_]+)\1/g)) names.add(n[2]);
    }
  }
  return names;
}

function allSettingsRows(doc: string): string[][] {
  const start = doc.indexOf('\n## All settings');
  expect(start, 'the reference has no "All settings" section').toBeGreaterThan(0);
  return doc
    .slice(start)
    .split('\n')
    .filter((l) => l.startsWith('| `MANDREL_'))
    .map((l) => l.replace(/^\|\s*|\s*\|\s*$/g, '').split(/(?<!\\) \| /));
}

describe('settings reference (docs/reference/configuration.md)', () => {
  it('matches a fresh run of the generator', async () => {
    const g = await loadGenerator();
    expect(fs.existsSync(g.REFERENCE_PATH), 'docs/reference/configuration.md is missing — run `npm run docs:config`').toBe(true);
    const committed = fs.readFileSync(g.REFERENCE_PATH, 'utf8');
    const fresh = g.generateReference();
    expect(
      committed === fresh,
      'docs/reference/configuration.md is out of date — run `npm run docs:config` (in mcp-server/) and commit the result',
    ).toBe(true);
  });

  it('lists exactly the settings a plain-text scan of src/config finds, each once', async () => {
    const g = await loadGenerator();
    const doc = fs.readFileSync(g.REFERENCE_PATH, 'utf8');
    const rows = allSettingsRows(doc);
    const documented = rows.map((r) => r[0].replace(/`/g, ''));
    expect(new Set(documented).size, 'a setting is listed twice').toBe(documented.length);
    const scanned = namesByTextScan(g.CONFIG_DIR);
    expect([...scanned].filter((n) => !documented.includes(n)), 'settings in src/config missing from the reference').toEqual([]);
    expect(documented.filter((n) => !scanned.has(n)), 'reference lists names that no env helper reads').toEqual([]);
    expect(documented.length).toBe(scanned.size);
    expect(doc).toContain(`lists all ${documented.length} \`MANDREL_*\` settings`);
  });

  it('gives every setting a type, a default and a plain-language description', async () => {
    const g = await loadGenerator();
    const doc = fs.readFileSync(g.REFERENCE_PATH, 'utf8');
    const rows = allSettingsRows(doc);
    expect(rows.length).toBeGreaterThan(200);
    for (const r of rows) {
      expect(r.length, `row ${r[0]} does not have four columns`).toBe(4);
      expect(r[1].trim(), `${r[0]} has no type`).not.toBe('');
      expect(r[2].trim(), `${r[0]} has no default`).not.toBe('');
      expect(g.descriptionProblem(r[3].trim()), `${r[0]} description`).toBeNull();
    }
  });

  it('opens with how to set a setting and a "Most people only need these" table', async () => {
    const g = await loadGenerator();
    const doc = fs.readFileSync(g.REFERENCE_PATH, 'utf8');
    const how = doc.indexOf('## How to set a setting');
    const most = doc.indexOf('## Most people only need these');
    const all = doc.indexOf('## All settings');
    expect(how).toBeGreaterThan(0);
    expect(most).toBeGreaterThan(how);
    expect(all).toBeGreaterThan(most);
    const table = doc.slice(most, all);
    for (const name of [
      'MANDREL_BELIEF_ENABLED',
      'MANDREL_BELIEF_ADJUDICATOR_PROVIDER',
      'MANDREL_BELIEF_TIER1_PROVIDER',
      'MANDREL_BELIEF_TIER1_MODEL',
      'MANDREL_BELIEF_TIER1_API_KEY_ENV',
      'MANDREL_BELIEF_TIER2_PROVIDER',
      'MANDREL_BELIEF_TIER2_MODEL',
      'MANDREL_BELIEF_TIER2_API_KEY_ENV',
    ]) {
      expect(table, `${name} missing from "Most people only need these"`).toContain(`\`${name}\``);
    }
    const provider = table.split('\n').find((l) => l.includes('`MANDREL_BELIEF_ADJUDICATOR_PROVIDER`')) ?? '';
    for (const v of ['anthropic', 'openai-compat', 'ollama', 'subq', 'tiered']) expect(provider).toContain(v);
    expect(g.ESSENTIALS.length).toBeLessThanOrEqual(20);
  });

  it('only lists allowed values that the config source actually spells out', async () => {
    const g = await loadGenerator();
    const sources = fs
      .readdirSync(g.CONFIG_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(path.join(g.CONFIG_DIR, f), 'utf8'))
      .join('\n');
    const providerSources = fs.readFileSync(path.resolve(g.CONFIG_DIR, '../services/belief/provider.ts'), 'utf8');
    for (const [name, values] of Object.entries(g.ALLOWED_VALUES)) {
      for (const v of values) {
        const quoted = new RegExp(`['"]${v}['"]`);
        expect(quoted.test(sources) || quoted.test(providerSources), `${name}: value "${v}" is not in the source`).toBe(true);
      }
    }
  });
});
