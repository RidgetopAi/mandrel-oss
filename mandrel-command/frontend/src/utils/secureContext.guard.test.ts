import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CALL-SITE guard for the insecure-context login break (2026-08-11).
 *
 * `utils/uuid.test.ts` proves the HELPER survives an insecure context. It cannot
 * prove the app CALLS the helper — a future edit could reintroduce a bare
 * `crypto.randomUUID()` at a request-path call site and every helper test would
 * stay green. That is the same "guard narrower than its name" shape that has bitten
 * us repeatedly, so this asserts the property directly.
 *
 * INSTRUMENT CHOICE: this is a question about shipped BYTES ("does this token appear
 * in source"), so grep-over-files is the right instrument. It is deliberately NOT a
 * question about the TS AST.
 *
 * `newCorrelationId` in utils/uuid.ts is the ONLY sanctioned caller — it is the file
 * that implements the fallback.
 */
const SRC = join(__dirname, '..');
const ALLOWED = ['utils/uuid.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('no bare crypto.randomUUID outside the fallback helper', () => {
  test('every call site goes through newCorrelationId', () => {
    const files = walk(SRC);
    // Sanity: the sweep must actually see a real population, or it proves nothing.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter((f) => {
      const rel = f.slice(SRC.length + 1).replace(/\\/g, '/');
      if (ALLOWED.includes(rel)) return false;
      if (/\.test\.tsx?$/.test(rel)) return false; // tests may stub it deliberately
      return /crypto\s*\.\s*randomUUID\s*\(/.test(readFileSync(f, 'utf8'));
    });

    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
