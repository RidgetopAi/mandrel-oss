/**
 * recordHeadlineDrift — pins `services/recordTitle.ts` (this backend's mirror) to the ONE
 * declaration of the record-headline rule, `mcp-server/src/config/recordHeadlineConfig.ts`,
 * read off disk.
 *
 * WHY A GUARD AND NOT AN IMPORT: stated in full at the top of `services/recordTitle.ts`.
 * Short form — separate services, no shared package, and this backend's runtime image does
 * not contain `mcp-server/`. Same technique as `actorRegistryDrift.test.ts`.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3). The rule has exactly two parts and both
 * are compared:
 *   1. THE TUNABLES — the whole `RECORD_HEADLINE_CONFIG` object literal plus the two
 *      module-level defaults it is built from, compared as normalised source. A number
 *      changed on one side only is RED, in either direction.
 *   2. THE ALGORITHM — the full body of `deriveRecordHeadline`, compared as normalised
 *      source. This is the part a constants-only guard would miss entirely: two files can
 *      agree on `maxChars: 180` and still cut in different places.
 * Comments are stripped before comparison, so prose may differ (it should — one file
 * explains, the other points at it); anything that EXECUTES may not.
 *
 * NO THIRD STATE (C1): a missing source file, a missing declaration, or an empty extraction
 * THROWS. This guard cannot pass because it failed to look.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  RECORD_HEADLINE_CONFIG,
  CONTEXT_TITLE_PREVIEW_CHARS,
  EMPTY_CONTEXT_TITLE,
  contextTitle,
  deriveRecordHeadline,
} from '../services/recordTitle';

const UPSTREAM_RELPATH = join('mcp-server', 'src', 'config', 'recordHeadlineConfig.ts');
const MIRROR_RELPATH = join('mandrel-command', 'backend', 'src', 'services', 'recordTitle.ts');

/** Walk UP until the ancestor containing the upstream config (worktree/CI-safe, C4). */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, UPSTREAM_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${UPSTREAM_RELPATH} in any ancestor of ${__dirname}. This guard derives ` +
      'its subject from that file; refusing to pass vacuously.'
  );
}

const ROOT = findRepoRoot();

function read(rel: string): string {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    throw new Error(`${rel} does not exist. Re-point this guard rather than deleting it.`);
  }
  return readFileSync(p, 'utf8');
}

const UPSTREAM = read(UPSTREAM_RELPATH);
const MIRROR = read(MIRROR_RELPATH);

/** Strip block + line comments, then collapse all whitespace. Executable text only. */
function normalise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Source of a `{ … }`-delimited declaration starting at `marker`, brace-matched. */
function braceBlock(src: string, marker: string, where: string): string {
  const start = src.indexOf(marker);
  if (start < 0) {
    throw new Error(
      `${where} no longer contains \`${marker}\`. The mirror and its source have diverged ` +
        'structurally — re-point this guard rather than deleting it.'
    );
  }
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error(`${where}: no '{' after \`${marker}\`.`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        const block = src.slice(start, i + 1);
        if (normalise(block).length < 20) {
          throw new Error(`${where}: extraction of \`${marker}\` came back empty.`);
        }
        return block;
      }
    }
  }
  throw new Error(`${where}: unbalanced braces after \`${marker}\`.`);
}

/** A `const NAME = <number>;` module-level default. */
function numericDefault(src: string, name: string, where: string): number {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
  if (!m) {
    throw new Error(`${where} no longer declares \`const ${name} = <number>\`.`);
  }
  return Number(m[1]);
}

describe('recordHeadlineDrift — the mirror equals its source', () => {
  it('the guard can see both files and both declarations (non-empty trap)', () => {
    expect(UPSTREAM.length).toBeGreaterThan(1000);
    expect(MIRROR.length).toBeGreaterThan(1000);
    expect(UPSTREAM).toContain('export function deriveRecordHeadline');
    expect(MIRROR).toContain('export function deriveRecordHeadline');
  });

  it('the tunables object is identical', () => {
    expect(normalise(braceBlock(MIRROR, 'export const RECORD_HEADLINE_CONFIG =', MIRROR_RELPATH)))
      .toBe(
        normalise(
          braceBlock(UPSTREAM, 'export const RECORD_HEADLINE_CONFIG =', UPSTREAM_RELPATH)
        )
      );
  });

  it('the two module-level defaults are identical', () => {
    for (const name of ['HEADLINE_MAX_CHARS_DEFAULT', 'HEADLINE_MIN_CHARS']) {
      expect(numericDefault(MIRROR, name, MIRROR_RELPATH)).toBe(
        numericDefault(UPSTREAM, name, UPSTREAM_RELPATH)
      );
    }
  });

  it('both read the SAME environment override', () => {
    const VAR = 'MANDREL_RECORD_HEADLINE_MAX_CHARS';
    expect(UPSTREAM).toContain(VAR);
    expect(MIRROR).toContain(VAR);
  });

  it('the ALGORITHM is identical, not just the numbers', () => {
    expect(normalise(braceBlock(MIRROR, 'export function deriveRecordHeadline', MIRROR_RELPATH)))
      .toBe(
        normalise(
          braceBlock(UPSTREAM, 'export function deriveRecordHeadline', UPSTREAM_RELPATH)
        )
      );
  });

  it('the scan window is derived the same way on both sides', () => {
    const pick = (src: string) => src.match(/const\s+SCAN_WINDOW_CHARS\s*=\s*([^;]+);/)?.[1]?.trim();
    expect(pick(MIRROR)).toBeTruthy();
    expect(pick(MIRROR)).toBe(pick(UPSTREAM));
  });

  it('the extractors fail CLOSED on a missing declaration', () => {
    // C1 third state: prove the "could not measure" branch throws rather than returning
    // something a comparison would call equal.
    expect(() => braceBlock('nothing here', 'export const RECORD_HEADLINE_CONFIG =', 'x')).toThrow();
    expect(() => numericDefault('nothing here', 'HEADLINE_MIN_CHARS', 'x')).toThrow();
  });
});

describe('recordHeadlineDrift — the backend surfaces read the mirror', () => {
  it('links.ts no longer declares its own preview constant or its own derivation', () => {
    const links = read(join('mandrel-command', 'backend', 'src', 'services', 'links.ts'));
    expect(links).not.toMatch(/const\s+CONTEXT_TITLE_PREVIEW_CHARS/);
    expect(links).not.toMatch(/\.(?:slice|substring|substr)\s*\(\s*0\s*,\s*\d+\s*\)/);
    expect(links).toMatch(/from\s+'\.\/recordTitle'/);
  });

  it('the back-compat constant IS the shared budget, not a second number', () => {
    expect(CONTEXT_TITLE_PREVIEW_CHARS).toBe(RECORD_HEADLINE_CONFIG.maxChars);
    expect(RECORD_HEADLINE_CONFIG.maxChars).toBe(
      numericDefault(UPSTREAM, 'HEADLINE_MAX_CHARS_DEFAULT', UPSTREAM_RELPATH)
    );
  });

  it('an absent headline still renders the neutral placeholder callers expect', () => {
    // The empty/absent population. `deriveRecordHeadline` returns null (absence is its own
    // value); only this UI-facing wrapper has an opinion about what to draw instead.
    expect(deriveRecordHeadline('')).toBeNull();
    expect(deriveRecordHeadline('  \n \t ')).toBeNull();
    expect(contextTitle('')).toBe(EMPTY_CONTEXT_TITLE);
    expect(contextTitle(null)).toBe(EMPTY_CONTEXT_TITLE);
    expect(contextTitle(undefined)).toBe(EMPTY_CONTEXT_TITLE);
  });

  it('never exceeds the budget and keeps whole words', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(10);
    const out = contextTitle(long);
    expect(out.length).toBeLessThanOrEqual(RECORD_HEADLINE_CONFIG.maxChars);
    expect(out.endsWith(RECORD_HEADLINE_CONFIG.ellipsis)).toBe(true);
    const body = out.slice(0, -RECORD_HEADLINE_CONFIG.ellipsis.length);
    expect(long.startsWith(body)).toBe(true);
    expect(/\s/.test(long.charAt(body.length))).toBe(true);
  });
});
