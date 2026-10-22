/**
 * GUARD — THE BROWSER MAKES ONLY MCP *READS*.
 *
 * an earlier task (Command UI project switcher trips the scope guard) and
 * 3f5615b9 (tenant UIs 401 on /mcp/tools/*). Both are the same class: the browser talking
 * to MCP as if it were an identified, long-lived connection, which it is not and cannot be.
 *
 * ── WHY A GUARD AND NOT A COMMENT ────────────────────────────────────────────────────────
 * A browser presents no `X-Connection-ID` and there is no value it could send that would
 * mean anything: per-mount = a brand-new process-global slot on every page load; per-user =
 * two tabs of one user fighting over one slot, i.e. the same last-writer-wins defect at
 * smaller scale. So the browser is a PERMANENT member of the unidentified population that
 * mcp-server/src/services/callerIdentityGuard.ts defends, and the invariant is not "send
 * the right header" but "never make a call that guard can reject."
 *
 * That invariant is one `callTool` away from being broken by anyone adding a convenience
 * wrapper, and breaking it FAILS SILENTLY twice over: the rejections land inside existing
 * try/catch telemetry paths, and today the guard is in `shadow` on prod so nothing surfaces
 * at all until the flip (backstop 2026-08-04). Prose could not hold this.
 *
 * ── THE CHOKE POINT ──────────────────────────────────────────────────────────────────────
 * `MandrelApiClient.callTool(toolName, …)` is the ONE funnel: every wrapper method on the
 * client (`ping`, `switchProject` before it was deleted, …) is implemented as a call to it,
 * and nothing else in the app POSTs to /mcp/tools/*. So scanning for the tool NAME passed to
 * `callTool` catches both direct calls and wrappers, which is why this guard anchors there
 * rather than on the wrapper names it happened to know about.
 *
 * ── THIS GUARD'S OWN POPULATION, AND ITS LIMIT (stated on purpose) ────────────────────────
 * ENUMERATES: every `.ts`/`.tsx` file under `mandrel-command/frontend/src`, recursively,
 * EXCLUDING `*.test.ts(x)` and `setupTests.ts`.
 *
 * WHY THAT IS THE WHOLE POPULATION FOR THE CLAIM IT MAKES: the claim is about code that can
 * execute in a user's browser. Test files never enter a browser bundle — vite builds from
 * `index.html` and tests are not reachable from that graph — so they cannot make a real call.
 * They are excluded because they must be free to NAME a rejectable op as a string fixture,
 * including this file, and including a mutation probe of this very guard (C3 corollary: a
 * guard that forbids its own probe gets deleted the first time it is inconvenient).
 *
 * WHAT THIS GUARD DOES **NOT** COVER, so nobody reads it as wider than it is:
 *   - the Command BACKEND (`mandrel-command/backend`) — it is an identified server-side
 *     caller and a different population; it was separately measured to have zero live
 *     project_switch call sites (evidence ctx 2afb338c).
 *   - runtime scripts, hooks, the bridge, or any non-browser caller.
 *   - whether a call is AUTHENTICATED. Reads are unaffected by callerIdentityGuard (its G3
 *     is deliberately read-blind) but they still need a credential; the tenant 401s of an earlier task
 *     were an auth gap (MANDREL_JWT_SECRET missing on the tenant mcp-servers), not
 *     an identity gap, and no repo-side assertion can see a prod-side env var.
 *
 * ── HOW THE REJECTABLE SET IS DERIVED ────────────────────────────────────────────────────
 * From `mcp-server/src/config/opRegistry.ts` — the product's own single source for op
 * effects — read off disk at test time. NEVER a hand-kept list: a list drifts the moment an
 * op is added or an effect is reclassified (`surveyor_scan_status` was corrected read→write
 * on 2026-07-28), and it would drift SILENTLY toward false-green.
 *
 * Rejectable = effect `write` (G2) or `scope-switch` (G1), PLUS any op absent from the
 * registry entirely, because `opEffect()` returns `'write'` for an unknown op (fail-closed,
 * opRegistry.ts:1067-1073). Mirroring that default is what makes `session_assign` — a
 * wrapper for a tool deleted in Phase 6, absent from the registry — a violation rather than
 * an unnoticed pass.
 *
 * ── ESCAPE HATCH ─────────────────────────────────────────────────────────────────────────
 * Co-located marker with a written reason on the same or the preceding line:
 *   // mcp-identity-allow: <why this specific call is safe>
 * Deliberately NOT a central allow-list: the reason belongs next to the call,
 * where the next reader is, and a bare marker with no reason text does not count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-relative location of the single source of truth for op effects. */
const OP_REGISTRY_RELPATH = join('mcp-server', 'src', 'config', 'opRegistry.ts');

/**
 * Walk UP from this file until we find the ancestor that contains the op registry.
 *
 * Derived, not hardcoded (C4): this suite runs from the shared dev tree, from any of N
 * parallel git worktrees under `_wt/`, and inside a container where the checkout root
 * differs again. A fixed `../../../..` would silently resolve to the wrong tree — or to
 * nothing — the first time the layout moved.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, OP_REGISTRY_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${OP_REGISTRY_RELPATH} in any ancestor of this test file. ` +
      `This guard derives its population from that file; refusing to pass vacuously.`
  );
}

const REPO_ROOT = findRepoRoot();
const FRONTEND_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `opId: 'x',` followed (within a few lines) by `effect: 'y',`. */
function parseOpEffects(source: string): Map<string, string> {
  const effects = new Map<string, string>();
  const re = /opId:\s*'([^']+)'\s*,[\s\S]{0,200}?effect:\s*'([\w-]+)'\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) effects.set(m[1], m[2]);
  return effects;
}

/** Mirrors opRegistry.ts opEffect(): an op absent from the registry is 'write'. */
function effectOf(op: string, effects: Map<string, string>): string {
  return effects.get(op) ?? 'write';
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'generated') continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue; // see "THIS GUARD'S OWN POPULATION"
    if (entry === 'setupTests.ts') continue;
    out.push(full);
  }
  return out;
}

/** Every `callTool('<op>'` / `callTool("<op>"` / `callTool(`<op>`` occurrence, with line no. */
/**
 * Find every `callTool('<op>'` in a file.
 *
 * ⚠️ SCANS THE WHOLE FILE TEXT, NOT LINE BY LINE — and that is the entire point.
 * The first version of this function ran the regex inside `lines.forEach`, so any `callTool(`
 * whose op literal wrapped onto the next line was INVISIBLE to the guard. That is not an exotic
 * shape: it is what **the repo's own Prettier config produces mechanically** from an ordinary
 * three-argument call, e.g.
 *
 *     await mandrelApi.callTool(
 *       'context_store',
 *       payload,
 *       options,
 *     );
 *
 * and the wrapper this branch deleted, `storeContext(content, type, tags)`, was exactly that
 * shape. Reviewer caught it with a mutation probe: the mutation landed, the guard stayed GREEN
 * where it had to go RED. A hole here is worse than no guard, because `mandrelApiClient.ts`
 * tells every future reader this invariant is "ENFORCED, not just documented" — so a silent
 * write would land under a promise of enforcement.
 *
 * The `\s*` between `(` and the quote already spans newlines; only the per-line slicing broke it.
 * Line numbers are derived from the match offset so diagnostics stay just as precise, and
 * `lineText`/`prevText` are still resolved (they carry the co-located allow-marker check).
 *
 * KNOWN AND DELIBERATE LIMITS — this is a literal-string scan, so it does NOT see:
 *   (a) an op passed via a variable — `const op = 'context_store'; callTool(op)`. No static
 *       string scan can close this; it needs types, and `callTool`'s signature is the place.
 *   (b) a direct `makeRequest('POST', '/mcp/tools/<op>')` that bypasses `callTool` entirely.
 *       That one is defended by the compiler instead: `makeRequest` is `private`, so reaching it
 *       requires an `as any` cast. Prefer keeping it private over widening this scan.
 */
function findCallToolOps(source: string): Array<{ op: string; line: number; lineText: string; prevText: string }> {
  const lines = source.split('\n');
  const hits: Array<{ op: string; line: number; lineText: string; prevText: string }> = [];
  const re = /callTool(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // 1-indexed line of the `callTool(` token itself, derived from the match offset.
    const idx = source.slice(0, m.index).split('\n').length - 1;
    hits.push({ op: m[1], line: idx + 1, lineText: lines[idx] ?? '', prevText: lines[idx - 1] ?? '' });
  }
  return hits;
}

/** A co-located marker must carry a REASON, not just the token. */
const ALLOW_RE = /mcp-identity-allow:\s*\S+/;

const registrySource = readFileSync(join(REPO_ROOT, OP_REGISTRY_RELPATH), 'utf8');
const OP_EFFECTS = parseOpEffects(registrySource);
const SOURCE_FILES = collectSourceFiles(FRONTEND_SRC);

describe('MCP caller-identity: the browser makes only reads', () => {
  // ── EMPTY / ZERO POPULATION PROBES ──────────────────────────────────────────────────
  // Both of this guard's inputs are parsed, and a parse that silently yields nothing turns
  // the real assertion below into `for (const x of []) {}` — permanently, quietly green.
  // These are the failures that would let the guard rot, so they are assertions, not
  // assumptions.

  it('derives a NON-EMPTY op-effect population from opRegistry.ts', () => {
    expect(OP_EFFECTS.size).toBeGreaterThan(20);
  });

  it('the parse actually understood the registry (sentinels, one per effect kind)', () => {
    // If the registry's formatting changes and the regex stops matching, size alone could
    // still look plausible. Pin one op of each effect so a partial parse is caught too.
    expect(OP_EFFECTS.get('project_switch')).toBe('scope-switch');
    expect(OP_EFFECTS.get('context_store')).toBe('write');
    expect(OP_EFFECTS.get('project_current')).toBe('read');
    // ...and at least one op of each kind exists, so neither bucket is empty.
    const kinds = new Set(OP_EFFECTS.values());
    expect(kinds).toContain('read');
    expect(kinds).toContain('write');
    expect(kinds).toContain('scope-switch');
  });

  it('enumerates a NON-EMPTY set of frontend source files', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(50);
  });

  it('the file scan actually reaches the client (the file it most needs to cover)', () => {
    // A zero-hit scan is indistinguishable from a clean scan. Prove the scanner both
    // reaches mandrelApiClient.ts AND finds real callTool sites in it.
    const client = SOURCE_FILES.find((f) => f.endsWith(join('api', 'mandrelApiClient.ts')));
    expect(client).toBeDefined();
    expect(findCallToolOps(readFileSync(client!, 'utf8')).length).toBeGreaterThan(0);
  });

  it('sees a callTool whose op literal WRAPPED to the next line (Prettier does this)', () => {
    // REGRESSION PIN — Reviewer's blocking finding, 2026-07-29. findCallToolOps originally
    // ran its regex per line, so this shape was invisible and a write could land silently
    // under a guard advertising itself as ENFORCED. This is not a hypothetical shape: it is
    // what the repo's own Prettier config emits from a three-argument call, and the wrapper
    // this branch deleted (storeContext(content, type, tags)) was exactly three arguments.
    const wrapped = [
      'async function danger() {',
      '  await mandrelApi.callTool(',
      "    'context_store',",
      '    payload,',
      '    options,',
      '  );',
      '}',
    ].join('\n');

    const hits = findCallToolOps(wrapped);
    expect(hits.map((h) => h.op)).toEqual(['context_store']);
    // The reported line must be the `callTool(` token (2), not the literal's line (3) —
    // otherwise the allow-marker check reads the wrong `prevText` and the escape silently
    // stops working for exactly the shape this test exists to cover.
    expect(hits[0].line).toBe(2);
    expect(hits[0].lineText).toContain('callTool(');

    // Single-line form must keep working — this pin must not become the only covered shape.
    expect(findCallToolOps("callTool('context_store', p)").map((h) => h.op)).toEqual([
      'context_store',
    ]);
  });

  // ── THE ASSERTION ───────────────────────────────────────────────────────────────────
  it('no frontend source file calls an op the caller-identity guard would reject', () => {
    const violations: string[] = [];

    for (const file of SOURCE_FILES) {
      const source = readFileSync(file, 'utf8');
      for (const hit of findCallToolOps(source)) {
        const effect = effectOf(hit.op, OP_EFFECTS);
        if (effect === 'read') continue;
        if (ALLOW_RE.test(hit.lineText) || ALLOW_RE.test(hit.prevText)) continue;

        const known = OP_EFFECTS.has(hit.op);
        violations.push(
          `${file.slice(REPO_ROOT.length + 1)}:${hit.line} calls '${hit.op}' ` +
            `(effect '${effect}'${known ? '' : ' — ABSENT from opRegistry, so opEffect() ' +
              'defaults it to write, fail-closed'}). A browser presents no X-Connection-ID, ` +
            `so callerIdentityGuard ${effect === 'scope-switch' ? 'G1' : 'G2'} rejects this ` +
            `under MANDREL_PROJECT_SCOPE_GUARD=enforce.`
        );
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ''
        : `The Command UI must not make MCP writes or scope-switches from the browser.\n\n` +
            violations.map((v) => `  • ${v}`).join('\n\n') +
            `\n\nFix: move the write behind the authenticated Command backend REST API ` +
            `(project-scoped by the X-Project-ID header the UI already sends), or use the ` +
            `UI's own state — the per-user default (SettingsContext.defaultProjectId) and ` +
            `the page's own usePageProject() selection. If a call is genuinely ` +
            `safe, mark it co-located WITH A REASON: // mcp-identity-allow: <why>`
    ).toEqual([]);
  });

  // ── REGRESSION PINS for the three wrappers deleted by an earlier task ─────────────────
  it('the client exposes no wrapper for a rejectable op', () => {
    const client = readFileSync(join(FRONTEND_SRC, 'api', 'mandrelApiClient.ts'), 'utf8');
    // Named explicitly because these three are the measured defect, not a guess: they are
    // what the browser actually called. The scan above is the general case; this is the
    // specific one, so a re-introduction reads as "you undid an earlier task".
    for (const removed of ['switchProject(', 'storeContext(', 'assignSession(']) {
      expect(client, `${removed} was removed by an earlier task — do not reintroduce it`)
        .not.toContain(`async ${removed}`);
    }
  });
});
