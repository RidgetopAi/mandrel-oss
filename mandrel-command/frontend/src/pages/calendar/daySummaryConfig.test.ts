/**
 * daySummaryConfig — NO PER-DEPLOYMENT ORIGIN MAY BE BAKED INTO THIS BUNDLE.
 *
 * THE CLASS THIS GUARDS
 * ---------------------
 * The frontend bundle is built ONCE and served by EVERY tenant. Any hostname literal
 * in it therefore ships to all of them. `shareBase` used to default to
 * `https://command.example.com`, and the PNG watermark rendered that same string as
 * a bare literal — so every tenant's Day-Summary share links and every tenant's
 * exported image pointed at OUR Command UI. That is the same defect, in the same
 * product, that commandUrlConfig.ts was fixed for on the server side after a customer
 * reported it.
 *
 * The fix reuses the established rule — "each instance emits its OWN origin" — via the
 * value the browser already has: window.location.origin. These tests pin BOTH halves:
 * the derivation is correct, AND no origin literal has crept back into the source.
 *
 * SCOPE OF THE SOURCE SCAN (stated, because a guard's own population is the thing
 * authors forget): it reads the two calendar day-summary source files this defect
 * lived in — daySummaryConfig.ts and DaySummary.tsx. It is NOT a whole-bundle sweep;
 * a hostname baked into some other component is not visible here.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DAY_SUMMARY_UI from './daySummaryConfig';

const SOURCES = ['daySummaryConfig.ts', 'DaySummary.tsx'];

/**
 * Locate this directory on disk. `import.meta.url` is an http(s) URL under the jsdom
 * environment, so it cannot be converted with fileURLToPath — resolve from the process
 * cwd instead, trying the roots vitest is legitimately started from. Throws (rather
 * than skipping) when nothing matches: a source scan that silently reads no file is a
 * hollow guard.
 */
function sourcePath(file: string): string {
  const candidates = [
    resolve(process.cwd(), 'src/pages/calendar', file),
    resolve(process.cwd(), 'frontend/src/pages/calendar', file),
    resolve(process.cwd(), 'mandrel-command/frontend/src/pages/calendar', file),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `daySummaryConfig.test: cannot locate ${file} from cwd ${process.cwd()} — ` +
        `tried:\n  ${candidates.join('\n  ')}`,
    );
  }
  return hit;
}

describe('daySummaryConfig — share origin is derived, never baked in', () => {
  it('shareBase is THIS instance’s own origin (jsdom: the test window’s origin)', () => {
    expect(DAY_SUMMARY_UI.shareBase).toBe(window.location.origin.replace(/\/+$/, ''));
    // Anti-vacuous: the value is a real origin, not an empty string that would make the
    // assertion above pass for the wrong reason.
    expect(DAY_SUMMARY_UI.shareBase).toMatch(/^https?:\/\/.+/);
  });

  it('watermarkHost is the host of that same origin', () => {
    expect(DAY_SUMMARY_UI.watermarkHost).toBe(window.location.host);
    expect(DAY_SUMMARY_UI.watermarkHost.length).toBeGreaterThan(0);
  });

  it('carries no reference to any example.com origin', () => {
    expect(DAY_SUMMARY_UI.shareBase).not.toContain('riverbend');
    expect(DAY_SUMMARY_UI.watermarkHost).not.toContain('riverbend');
  });

  it.each(SOURCES)(
    '%s contains no hardcoded per-deployment origin (the literal that shipped the bug)',
    (file) => {
      const src = readFileSync(sourcePath(file), 'utf8');
      // Strip block + line comments first: the comments in these files explain the
      // defect and legitimately NAME the old hostname. Guarding the comments would
      // make the guard block the documentation of its own reason — and a guard that
      // blocks correct work gets deleted (CLASSES.md C3 corollary).
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // THE SCHEME IS OPTIONAL ON PURPOSE. The watermark defect was a BARE hostname —
      // `· command.example.com ·` with no https:// in front of it — so a scan
      // anchored on `https?://` would have passed the exact line that shipped the bug.
      // Matching only the shapes you had in mind is how a guard ends up hollow
      // (CLASSES.md C3), so this matches a domain-like token with or without a scheme.
      //
      // Any real deployment host, not just ours: a tenant-specific host from ANY
      // deployment is equally wrong in a bundle every tenant shares. The TLD list is
      // the real-world set; the reserved test TLDs (.test/.example/.invalid/.localhost)
      // are deliberately NOT in it, so fixtures and placeholders stay legal — a guard
      // that forbids legitimate work gets deleted the first time it is inconvenient.
      const ORIGIN_LIKE =
        /(?:https?:\/\/)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:net|com|org|io|ai|dev|app|co)\b/g;
      const origins = code.match(ORIGIN_LIKE) ?? [];
      expect(origins).toEqual([]);
    },
  );
});
