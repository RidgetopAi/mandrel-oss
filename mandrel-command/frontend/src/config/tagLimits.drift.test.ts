/**
 * tagLimitsDrift — pins this package's TRANSIENT tag caps to their ONE source of truth,
 * `mcp-server/src/config/fieldLimits.ts` `TRANSIENT_LIMITS`, read off disk
 *.
 *
 * ═══ WHY THIS GUARD AND NOT AN IMPORT ═══════════════════════════════════════════════
 * Stated in full in `src/config/fieldLimits.ts`: `docker-compose.build.yml:58-59` gives
 * this image the build context `./mandrel-command`, so `mcp-server/` is not present at
 * build time at any path. An import compiles locally and breaks the image.
 *
 * ═══ WHY A TRANSIENT LIMIT CANNOT USE THE COLUMN-BACKED CHAIN ═══════════════════════
 * `tasks.assigned_to` bottoms out at `information_schema` — the lowest rung of the C1
 * instrument ladder, which is why `assignedToFieldLimit.db.test.ts` can be DB-backed. The
 * tag caps have NO column: `tags` is an unbounded `TEXT[]`. They are product policy, and
 * policy's lowest available rung is the declaration that documents itself as the policy.
 * So this guard reads that declaration directly rather than relaying it through a rung
 * that would only add a place to be wrong.
 *
 * ═══ THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3) ═══════════════════════════════
 * Every entry of this package's `TRANSIENT_LIMITS` (the caps it actually enforces — a
 * mirrored entry with no consumer is a copy that rots unobserved). For each, the upstream
 * key MUST EXIST and MUST agree. Existence is asserted separately from agreement, because
 * an upstream RENAME would otherwise present as "nothing to compare" and pass silently.
 *
 * ═══ INSTRUMENT HONESTY ═════════════════════════════════════════════════════════════
 * Upstream declarations are flat literal object entries — a BYTES-shaped property — so a
 * byte-level parse is the right instrument, made honest by (a) a NON-EMPTY TRAP: a parse
 * that finds nothing FAILS rather than passing over an empty set, and (b) an explicit
 * THIRD STATE: if the upstream file is missing or no longer declares `TRANSIENT_LIMITS`,
 * this THROWS. "I could not measure" must never be reported as "no drift".
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { TRANSIENT_LIMITS, TAG_LENGTH, TAG_COUNT } from './fieldLimits';
import { AidisContextStoreSchema, CreateContextSchema } from '../validation/schemas';

const HERE = dirname(fileURLToPath(import.meta.url));

const UPSTREAM_RELPATH = join('mcp-server', 'src', 'config', 'fieldLimits.ts');

/** Walk UP until the ancestor containing the upstream declaration (worktree/CI-safe, C4). */
function findRepoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, UPSTREAM_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${UPSTREAM_RELPATH} in any ancestor of ${HERE}. This guard ` +
      'derives its expected caps from that file; refusing to pass vacuously.'
  );
}

/** Parse `TRANSIENT_LIMITS` entries: `key: {\n max: N,` → Map<key, max>. */
function parseUpstreamTransientLimits(): Map<string, number> {
  const source = readFileSync(join(findRepoRoot(), UPSTREAM_RELPATH), 'utf8');
  const start = source.indexOf('export const TRANSIENT_LIMITS');
  if (start === -1) {
    throw new Error(
      `${UPSTREAM_RELPATH} no longer declares \`TRANSIENT_LIMITS\`. The mirror in ` +
        'src/config/fieldLimits.ts has lost its source of truth — re-point this guard ' +
        'rather than deleting it.'
    );
  }
  // Bound the scan to the registry literal so a `max:` elsewhere in the file cannot leak in.
  const end = source.indexOf('} as const satisfies', start);
  if (end === -1) {
    throw new Error(`Could not find the end of TRANSIENT_LIMITS in ${UPSTREAM_RELPATH}.`);
  }
  const body = source.slice(start, end);
  const out = new Map<string, number>();
  const re = /^\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{\s*$\n\s*max:\s*(\d+),/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.set(m[1], Number(m[2]));
  return out;
}

const upstream = parseUpstreamTransientLimits();

describe('frontend tag caps mirror the mcp-server TRANSIENT_LIMITS registry', () => {
  it('parsed a non-empty registry from the upstream file', () => {
    // THE NON-EMPTY TRAP. Without it an upstream reformat empties the parse and every
    // comparison below passes while comparing nothing.
    expect(upstream.size).toBeGreaterThan(0);
    expect(TRANSIENT_LIMITS.length).toBeGreaterThan(0);
  });

  it('declares only keys that EXIST upstream (an upstream rename is RED, not silent)', () => {
    for (const limit of TRANSIENT_LIMITS) {
      expect(
        upstream.has(limit.key),
        `this package mirrors '${limit.key}', which no longer exists in ${UPSTREAM_RELPATH}`
      ).toBe(true);
    }
  });

  it('agrees with upstream on every mirrored cap', () => {
    for (const limit of TRANSIENT_LIMITS) {
      expect(limit.max, `cap drift on '${limit.key}'`).toBe(upstream.get(limit.key));
      expect(limit.why.trim().length).toBeGreaterThan(0);
    }
  });

  // ── A cap is only fixed if the SCHEMAS actually read it. A config nobody consumes is not
  // a fix — this is the assertion that catches a mirror updated while a literal survives.
  it('the tag schema accepts exactly the derived caps and rejects one more of each', () => {
    const base = { content: 'cap probe content', type: 'code' as const };
    const parse = (tags: string[]) =>
      CreateContextSchema.safeParse({ ...base, tags }).success;

    // LENGTH boundary — derived from the mirror, never a literal in this file.
    expect(parse(['a'.repeat(TAG_LENGTH.max)])).toBe(true);
    expect(parse(['a'.repeat(TAG_LENGTH.max + 1)])).toBe(false);

    // COUNT boundary.
    const tag = (i: number) => `t${i}`;
    expect(parse(Array.from({ length: TAG_COUNT.max }, (_, i) => tag(i)))).toBe(true);
    expect(parse(Array.from({ length: TAG_COUNT.max + 1 }, (_, i) => tag(i)))).toBe(false);

    // THE EMPTY POPULATION: no tags is legal and is not an error.
    expect(parse([])).toBe(true);
  });

  it('the SECOND frontend enforcement point derives too (AidisContextStoreSchema)', () => {
    // The sweep found TWO hand-copies in this file, and only one went through the shared
    // `tags` helper. Guarding only the helper would pass while a live literal survived —
    // so this names the other consumer explicitly rather than trusting the refactor.
    const store = (tags: string[]) =>
      AidisContextStoreSchema.safeParse({ content: 'x', type: 'code', tags }).success;
    expect(store(['a'.repeat(TAG_LENGTH.max)])).toBe(true);
    expect(store(['a'.repeat(TAG_LENGTH.max + 1)])).toBe(false);
  });

  it('accepts the 11..20-tag range the old literal-10 cap wrongly rejected', () => {
    // The actual user-visible defect: a record MCP accepts and Postgres stores, that this
    // surface refused to save. 11 is inside the upstream policy and outside the old copy.
    const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(eleven.length).toBeGreaterThan(10);
    expect(eleven.length).toBeLessThanOrEqual(TAG_COUNT.max);
    expect(
      CreateContextSchema.safeParse({
        content: 'eleven tags content', type: 'code', tags: eleven,
      }).success
    ).toBe(true);
  });
});
