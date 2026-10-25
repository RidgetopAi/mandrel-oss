/**
 * THE CODE DEFAULT MUST BE THE FLEET DEFAULT — for MANDREL_EMBEDDER (an earlier task
 * and an earlier change).
 *
 * THE CLASS THIS GUARDS: a setting is rolled across the EXISTING fleet by
 * hand while the code/compose default is left on the old value. The existing fleet masks
 * it completely — everything looks healthy — until a NEW tenant is provisioned, or one
 * hand-typed env line is lost, and that instance is silently born on the wrong value.
 * For MANDREL_EMBEDDER that failure mode is total and silent: the process reads+writes a
 * vector column nothing else uses, so search returns EMPTY with no error and no alert.
 *
 * THE POPULATION THIS FILE ENUMERATES, and why it is the whole one: there are exactly
 * THREE places the MANDREL_EMBEDDER default is written down in this repo, and this file
 * reads all three —
 *   1. the mcp-server code default        (mcp-server/src/config/embeddingConfig.ts)
 *   2. the Command backend code default   (mandrel-command/backend/src/config/embeddingColumn.ts)
 *   3. the compose default(s)             (docker-compose.yml, declared per service)
 * (1) is read from the RUNNING module, not from its text — the strongest available rung
 * (CLASSES.md C1: observed value beats a regex over source). (2)(3) live outside this
 * package's tsconfig/workspace and cannot be imported, so they are parsed, exactly as the
 * sibling shell guards parse them.
 *
 * NOTHING HERE HARDCODES THE VALUE. The test does not know or care whether the answer is
 * `gemma` or `minilm`; it asserts only that all three agree. Pinning the literal would make
 * this file a second place the rule is written down — the very defect it exists to catch.
 *
 * A ZERO-MATCH EXTRACTION IS A FAILURE, NEVER A PASS (C1's third state). If a default
 * moves to a shape these patterns do not match, this file must say "I could not measure",
 * not quietly assert nothing.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** <repo>/mcp-server/src/tests -> <repo> */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const VAR = 'MANDREL_EMBEDDER';

function readRepoFile(rel: string): string {
  const abs = path.join(REPO_ROOT, rel);
  expect(fs.existsSync(abs), `source of truth is missing: ${rel}`).toBe(true);
  return fs.readFileSync(abs, 'utf8');
}

/** All capture-group-1 matches, deduped. Empty result is the caller's failure to report. */
function allMatches(text: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Exactly-one-distinct-value extraction; zero matches fails loudly (C1 third state). */
function soleValue(text: string, re: RegExp, label: string): string {
  const vals = allMatches(text, re);
  expect(
    vals.length,
    `COULD NOT MEASURE ${label}: pattern ${re} matched ${vals.length} distinct value(s) ` +
      `(${JSON.stringify(vals)}). Zero means the declaration moved and this guard went blind; ` +
      `more than one means the same default is written down twice and they disagree.`,
  ).toBe(1);
  return vals[0];
}

describe(`${VAR}: the code default is the fleet default`, () => {
  const PRIOR = process.env[VAR];

  beforeEach(() => {
    delete process.env[VAR];
  });
  afterEach(() => {
    if (PRIOR === undefined) delete process.env[VAR];
    else process.env[VAR] = PRIOR;
  });

  /** (1) OBSERVED, not parsed: what the shipped module actually returns with the env absent. */
  async function mcpServerCodeDefault(): Promise<string> {
    const mod = await import('@/config/embeddingConfig');
    return mod.activeEmbedderKey();
  }

  /** (2) The Command backend's independent mirror of the same rule. */
  function backendCodeDefault(): string {
    const src = readRepoFile('mandrel-command/backend/src/config/embeddingColumn.ts');
    return soleValue(
      src,
      new RegExp(`process\\.env\\.${VAR}\\s*\\|\\|\\s*'([^']*)'`, 'g'),
      'the Command backend code default',
    );
  }

  /** (3) The compose default(s) — declared once per service, and they must be identical. */
  function composeDefaults(): string[] {
    const src = readRepoFile('docker-compose.yml');
    return allMatches(src, new RegExp(`${VAR}:\\s*"\\$\\{${VAR}:-([^}]*)\\}"`, 'g'));
  }

  function composeDeclarationCount(): number {
    const src = readRepoFile('docker-compose.yml');
    return [...src.matchAll(new RegExp(`^\\s*${VAR}:\\s*"\\$\\{${VAR}:-`, 'gm'))].length;
  }

  it('measures a default from every one of the three places it is written down', async () => {
    // The guard's own liveness check: if any extraction goes blind, every equality
    // assertion below becomes vacuous, so prove all three produced a value FIRST.
    const mcp = await mcpServerCodeDefault();
    expect(mcp, 'mcp-server code default resolved to an empty value').not.toBe('');

    expect(backendCodeDefault(), 'backend code default resolved to an empty value').not.toBe('');

    const compose = composeDefaults();
    expect(
      compose.length,
      `COULD NOT MEASURE the compose default(s): matched ${JSON.stringify(compose)}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('declares the same compose default on BOTH readers (split-brain guard)', () => {
    // The two processes pick the vector column INDEPENDENTLY from this one name. One
    // declaration is worse than none: the writer moves and the reader does not.
    expect(composeDeclarationCount()).toBeGreaterThanOrEqual(2);
    expect(
      composeDefaults(),
      'the per-service compose defaults disagree — the Command backend would query a ' +
        'different vector column than the mcp-server writes',
    ).toHaveLength(1);
  });

  it('the mcp-server code default equals the Command backend code default', async () => {
    expect(await mcpServerCodeDefault()).toBe(backendCodeDefault());
  });

  it('the compose default equals the code default', async () => {
    expect(composeDefaults()[0]).toBe(await mcpServerCodeDefault());
  });

  it('an absent env var is NOT an error — it yields the default (the empty-population probe)', async () => {
    expect(process.env[VAR]).toBeUndefined();
    await expect(mcpServerCodeDefault()).resolves.toBeTruthy();
  });

  it('an EMPTY env var is treated as absent, not as an unknown embedder', async () => {
    process.env[VAR] = '';
    const mod = await import('@/config/embeddingConfig');
    expect(mod.activeEmbedderKey()).toBe(await (async () => {
      delete process.env[VAR];
      return mcpServerCodeDefault();
    })());
  });
});
