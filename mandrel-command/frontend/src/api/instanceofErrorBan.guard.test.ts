/**
 * an earlier task — THE BAN THAT MAKES SITE #49 IMPOSSIBLE, and the guard on that ban.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * Forty-eight call sites in this app were written `err instanceof Error ? err.message :
 * '<generic>'`, and every one was wrong for its whole life — the shared axios interceptor
 * rejects with a plain object, so the test was always false and no user ever saw a server
 * message. They converged on a broken idiom because NOTHING OBJECTED. Sweeping them fixes
 * 48 instances; it does not stop the 49th. `.eslintrc.cjs` now bans the expression in
 * `src/pages` + `src/components` — that is the whole-class fix.
 *
 * But a lint rule is only a guard if it FIRES, and "we added a rule" is a claim like any
 * other. A rule can be silently defanged by deleting the override, renaming the selector,
 * narrowing `files`, or an `extends` reordering — and every existing test in this repo
 * would stay green, because none of them lint anything. That is the same disease one layer
 * up (guards-need-guarding); we have hit it repeatedly.
 *
 * So this test HANDS THE ARTIFACT TO ITS REAL INTERPRETER: it runs the actual
 * ESLint, loading the actual `.eslintrc.cjs` from disk, against source it fabricates at a
 * path inside the banned directories, and requires a real diagnostic back. It never
 * re-implements the selector — a test that inlined the regex/selector would be regressable
 * with the detector broken and all tests green.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '../..');

/** The real ESLint, with the real on-disk config. No inline rule definitions. */
const eslint = new ESLint({ cwd: frontendRoot });

const RULE = 'no-restricted-syntax';

async function lint(code: string, relPath: string) {
  const results = await eslint.lintText(code, { filePath: resolve(frontendRoot, relPath) });
  return results[0]?.messages ?? [];
}

const banHits = (msgs: Awaited<ReturnType<typeof lint>>) =>
  msgs.filter((m) => m.ruleId === RULE);

describe('the `instanceof Error` ban is real, and fires where it must', () => {
  beforeAll(() => {
    // If eslint ever stops resolving here, every assertion below would trivially "pass"
    // by finding zero violations in the negative cases. Fail loudly instead.
    expect(typeof ESLint).toBe('function');
  });

  it('FIRES on a fresh `instanceof Error` in a page component (this is site #49)', async () => {
    const msgs = await lint(
      `export const f = (e: unknown) => (e instanceof Error ? e.message : 'boom');\n`,
      'src/pages/__ban_probe.ts',
    );
    const hits = banHits(msgs);
    expect(hits).toHaveLength(1);
    // The message has to TELL the developer what to do instead, or the rule is a wall
    // with no door and the next person disables it.
    expect(hits[0].message).toContain('apiErrorMessage');
    expect(hits[0].severity).toBe(2); // ERROR — the CI gate tolerates warnings, so this matters
  });

  it('FIRES in EVERY banned directory, not only pages', async () => {
    // Enumerated so that adding a directory to the rule without adding it here is visible,
    // and so a directory silently dropping OUT of the rule's `files` is a RED.
    for (const dir of ['src/pages', 'src/components', 'src/contexts']) {
      const msgs = await lint(
        `export const g = (e: unknown) => { if (e instanceof Error) return e.message; return ''; };\n`,
        `${dir}/__ban_probe.ts`,
      );
      expect(banHits(msgs), `expected the ban to cover ${dir}`).toHaveLength(1);
    }
  });

  it('FIRES on forms nobody wrote as a ternary — the selector is the AST node, not a shape', async () => {
    // The point of anchoring on the BinaryExpression rather than on the idiom's text: a
    // new instance cannot be phrased around the rule.
    for (const code of [
      `export const a = (e: unknown) => e instanceof Error && e.message;\n`,
      `export const b = (e: unknown) => { const ok = e instanceof Error; return ok; };\n`,
      `export const c = (e: unknown) => [e].filter((x) => x instanceof Error);\n`,
      `export const d = (e: unknown) => !(e instanceof Error);\n`,
    ]) {
      expect(banHits(await lint(code, 'src/pages/__ban_probe.ts'))).toHaveLength(1);
    }
  });

  it('does NOT fire outside the render layers — the legitimate producers/adapters stay legal', async () => {
    // hooks/useQueryErrorHandler (wraps INTO an Error for Sentry), hooks/useErrorHandler
    // (reads .name), api/mandrelApiClient (normalises to {message}). Scoping the ban to the
    // consumers is deliberate; a rule mostly made of exemptions is one nobody reads.
    const code = `export const h = (e: unknown) => (e instanceof Error ? e : new Error('x'));\n`;
    expect(banHits(await lint(code, 'src/hooks/__ban_probe.ts'))).toHaveLength(0);
    expect(banHits(await lint(code, 'src/api/__ban_probe.ts'))).toHaveLength(0);
  });

  it('ANTI-VACUOUS: clean code in a banned directory produces NO hit', async () => {
    // Without this, every "FIRES" assertion above could be satisfied by a rule that flags
    // everything, and the "does NOT fire" case by a rule that flags nothing.
    const msgs = await lint(
      `import { apiErrorMessage } from '../api/request';\n` +
        `export const f = (e: unknown) => apiErrorMessage(e, 'boom');\n`,
      'src/pages/__ban_probe.ts',
    );
    expect(banHits(msgs)).toHaveLength(0);
  });

  it('every exemption for THIS rule in the banned dirs suppresses a REAL violation', async () => {
    // Co-located exemptions are the design — but an exemption that has stopped
    // suppressing anything is a hole that reads like a guard. ESLint itself is the only
    // honest judge of "does this directive suppress something", so ask it.
    //
    // Scoped to THIS rule on purpose: the repo carries 25 pre-existing stale directives for
    // OTHER rules, and failing on those would make this guard about somebody else's work
    // and get it disabled.
    const scoped = new ESLint({ cwd: frontendRoot, reportUnusedDisableDirectives: 'error' });
    const results = await scoped.lintFiles([
      'src/pages/**/*.{ts,tsx}',
      'src/components/**/*.{ts,tsx}',
      'src/contexts/**/*.{ts,tsx}',
    ]);

    const staleForOurRule = results.flatMap((r) =>
      r.messages
        .filter((m) => /Unused eslint-disable directive/.test(m.message) && m.message.includes(RULE))
        .map((m) => `${r.filePath.split('/frontend/')[1]}:${m.line}`),
    );

    expect(staleForOurRule).toEqual([]);
  });

  it('POSITIVE CONTROL: that staleness check can actually detect a stale exemption', async () => {
    // The check above asserts an EMPTY list — the value that slips past a naive guard. Prove
    // the detector is capable of a non-empty answer, or "no stale exemptions" might just
    // mean "this never looks at anything" (mutation-probe the probe).
    const scoped = new ESLint({ cwd: frontendRoot, reportUnusedDisableDirectives: 'error' });
    const results = await scoped.lintText(
      `// eslint-disable-next-line no-restricted-syntax -- suppresses nothing\nexport const ok = 1;\n`,
      { filePath: resolve(frontendRoot, 'src/pages/__ban_probe.ts') },
    );
    const stale = results[0].messages.filter(
      (m) => /Unused eslint-disable directive/.test(m.message) && m.message.includes(RULE),
    );
    expect(stale).toHaveLength(1);
  });
});
