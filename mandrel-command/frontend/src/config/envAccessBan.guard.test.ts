/**
 * an earlier task — the dynamic-`import.meta.env`-read ban is real, and fires.
 *
 * WHY: a single `import.meta.env[name]` read makes Vite inline the ENTIRE env
 * object into that chunk — every loaded VITE_ var, readers or not. On the
 * on-host deploy paths that shipped the untracked `.env.production.local`
 * verbatim to every tenant (VITE_MCP_BASE_URL, a var with NO reader in src,
 * was measured in 3 prod chunks). `.eslintrc.cjs` now bans the escape shapes;
 * scripts/check-frontend-bundle-env.sh REDs the built artifact as the choke
 * point. This test guards the LINT layer the same way
 * instanceofErrorBan.guard.test.ts guards its ban: it runs the REAL ESLint
 * with the REAL on-disk config — never a re-implementation of the selectors
 * — and requires a real diagnostic back, so a silently defanged
 * rule is a RED here, not a quiet hole.
 *
 * POPULATION: the escape shapes enumerated in DYNAMIC_ENV_READ_BANS. The lint
 * layer does not claim exhaustiveness — the bundle scan is the choke point.
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '../..');

const eslint = new ESLint({ cwd: frontendRoot });
const RULE = 'no-restricted-syntax';

async function lint(code: string, relPath: string) {
  const results = await eslint.lintText(code, { filePath: resolve(frontendRoot, relPath) });
  return results[0]?.messages ?? [];
}

/** Hits from OUR ban only — identified by the message naming the env object. */
const envBanHits = (msgs: Awaited<ReturnType<typeof lint>>) =>
  msgs.filter((m) => m.ruleId === RULE && /env/i.test(m.message));

describe('dynamic import.meta.env reads are banned src-wide', () => {
  it('FIRES on the exact shape that shipped the leak — a computed read', async () => {
    const msgs = await lint(
      `export const f = (name: string) => import.meta.env[name];\n`,
      'src/config/__env_ban_probe.ts',
    );
    const hits = envBanHits(msgs);
    expect(hits).toHaveLength(1);
    // The message must hand the developer the correct idiom, or the rule is a
    // wall with no door and the next person disables it.
    expect(hits[0].message).toContain('import.meta.env.VITE_X');
    expect(hits[0].severity).toBe(2); // ERROR — the CI gate lint tolerates warnings only
  });

  it('FIRES on the escape shapes: alias, destructure, spread, single `as` cast', async () => {
    for (const code of [
      `export const e = import.meta.env;\n`,
      `const { VITE_API_URL } = import.meta.env; export default VITE_API_URL;\n`,
      `export const all = { ...import.meta.env };\n`,
      // The cast evasion Reviewer flagged (N1) — measured to make Vite inline `{}`,
      // so every read silently returns undefined in production.
      `export const f = (n: string) => (import.meta.env as Record<string, string>)[n];\n`,
      `const e = import.meta.env as Record<string, string>; export default e;\n`,
    ]) {
      expect(envBanHits(await lint(code, 'src/config/__env_ban_probe.ts')),
        `expected the ban to fire on: ${code.trim()}`).not.toHaveLength(0);
    }
  });

  it('FIRES inside the pages/components/contexts override too — the override REPLACES the top-level rule array, so losing the re-injection there is a hole', async () => {
    // Enumerated per-directory so a directory silently dropping the env bans is
    // a named RED, not a statistical one.
    for (const dir of ['src/pages', 'src/components', 'src/contexts', 'src/api', 'src/hooks']) {
      const msgs = await lint(
        `export const f = (name: string) => import.meta.env[name];\n`,
        `${dir}/__env_ban_probe.ts`,
      );
      expect(envBanHits(msgs), `expected the env ban to cover ${dir}`).toHaveLength(1);
    }
  });

  it('ANTI-VACUOUS: a STATIC read is legal everywhere — a guard that blocks the correct idiom gets deleted (C3 corollary)', async () => {
    for (const dir of ['src/config', 'src/pages']) {
      const msgs = await lint(
        `export const base = import.meta.env.VITE_API_URL || '/api';\n`,
        `${dir}/__env_ban_probe.ts`,
      );
      expect(envBanHits(msgs), `static read must stay legal in ${dir}`).toHaveLength(0);
    }
  });

  it('the fixed config files themselves lint clean under the real rule', async () => {
    const results = await new ESLint({ cwd: frontendRoot }).lintFiles([
      'src/pages/calendar/daySummaryConfig.ts',
      'src/config/navLinks.ts',
      'src/config/highlight.ts',
    ]);
    const hits = results.flatMap((r) => envBanHits(r.messages).map((m) => `${r.filePath}:${m.line}`));
    expect(hits).toEqual([]);
    // Anti-vacuous: three files were actually linted, not zero.
    expect(results).toHaveLength(3);
  });
});
