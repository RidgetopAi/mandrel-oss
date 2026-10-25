/**
 * RESERVED ARG-NAME PREFIX IN A QUERY — Contract Test.
 *
 * THE BUG THIS PINS (dogfood snag, an earlier note — reproduced on BOTH tool surfaces):
 *   `context_search({ query: 'id:071df00d-…' })` SILENTLY returned an unrelated record.
 *   `id:<uuid>` READS like query syntax, but there is no query DSL. The `:` fails
 *   HEX_PREFIX_RE (utils/idResolver.ts), so `queryLooksLikeId()` returns false, the
 *   id-prefix SQL arm is never emitted, the partial-tag arm matches no tag (+0), and the
 *   result is pure cosine noise presented as a confident answer. Worst failure shape we
 *   ship: wrong-with-confidence, not loud.
 *
 * The notation was ADVERTISED by the product (the truncation affordance in
 * config/recallConfig.ts, emitted on EVERY truncated row, plus the tool schema description
 * in config/opRegistry.ts) — so the product itself TAUGHT the misread. The fix has two
 * halves and this file guards both:
 *   PART A — nothing advertises a `tool arg:value` form any more (surface-neutral wording
 *            that is correct on the flat AND gateway surfaces).
 *   PART B — a reserved-prefix query FAILS LOUD, naming the correct parameter form.
 *
 * DELIBERATELY NOT A DSL (rejected by Coordinator): Part B ERRORS; it never RESOLVES. We do not
 * parse `id:<uuid>` and run the lookup — that would contradict the documented bare-token
 * design and invite extending a half-DSL to every prefix forever.
 *
 * THE LINE THIS MUST NOT CROSS — tag-grammar prefixes (`ref:`, `task:`, `decision:`, …) are
 * LEGITIMATE free-text queries served by the partial-tag substring arm. `ref:resume` drives
 * our boot ritual. Erroring on those would be a self-inflicted outage, so the "still works"
 * cases below are as load-bearing as the "now errors" cases.
 *
 * Drives the REAL public tool path (zod validator → contextRoutes.handleSearch → real
 * migrated Postgres, the disposable ci_* DB from scripts/provision-test-db.sh — never
 * production), the same idiom as contextSearchIdTagLookup.contract.test.ts.
 */

import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

import { activeEmbedder } from '../config/embeddingConfig.js';

// DERIVED, never hardcoded (same reason as contextSearchIdTagLookup): the active embedder
// decides the column and the geometry, so the same tests run under minilm AND gemma.
const DIM = activeEmbedder().dimensions;

const DIR_NOISE = 5;
const DIR_TARGET = 7;
const HEXISH_RE = /^[0-9a-f-]{8,}$/i;

function conceptVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const trimmed = text.trim();
  const lower = ` ${trimmed.toLowerCase()} `;
  if (HEXISH_RE.test(trimmed) || [' harbor ', ' pilot ', ' vessel '].some((w) => lower.includes(w))) {
    v[DIR_NOISE] = 1;
  } else {
    v[DIR_TARGET] = 1;
  }
  return v;
}
function pgVec(text: string): string {
  return `[${conceptVector(text).join(',')}]`;
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptVector(text),
      dimensions: DIM,
      model: 'concept-mock-minilm',
    })),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { contextRoutes } from '../routes/context.routes.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { searchRoutes } from '../routes/search.routes.js';
import { dispatchGateway } from '../routes/gateway.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import {
  queryLooksLikeId,
  reservedArgPrefixInQuery,
  reservedArgPrefixMessage,
  matchesReservedPrefix,
} from '../utils/idResolver.js';
import {
  RESERVED_QUERY_PREFIXES_EFFECTIVE,
  SEARCH_PROTECTED_TAG_GRAMMAR_PREFIXES,
} from '../config/searchConfig.js';

/** The reserved prefix names configured for one tool. */
const reservedFor = (tool: string) => Object.keys(RESERVED_QUERY_PREFIXES_EFFECTIVE[tool] ?? {});
import { recallSnippetBudget, RECALL_CONCISE_MAXLEN } from '../config/recallConfig.js';
import { clipBody } from '../services/altitudeProjection.js';
import { OP_REGISTRY } from '../config/opRegistry.js';

const STAMP = Date.now();
const PROJ_NAME = `reserved-prefix-${STAMP}`;
const TAG_TARGET = 'ref:resume';
const TASK_TAG = 'task:4d13f00d';

let projectId: string;
/** The record a correct `id` call must return — prose that does NOT match the noise concept. */
let target: string;

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(rawArgs: any) {
  const validated = validateToolArguments('context_search', rawArgs);
  return contextRoutes.handleSearch(validated);
}

const rows = (resp: any): any[] => resp?.structuredContent?.results ?? [];
const text = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';
/** Alias used by the gateway block — same rendered text channel. */
const responseText = text;

async function seed(opts: {
  content: string;
  type?: string;
  tags?: string[];
  embedded?: boolean;
}): Promise<string> {
  const res = await db.query(
    `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()}, relevance_score, tags)
     VALUES ($1, $2, $3, $4::vector, 5.0, $5)
     RETURNING id::text AS id`,
    [
      projectId,
      opts.type ?? 'planning',
      opts.content,
      opts.embedded === false ? null : pgVec(opts.content),
      opts.tags ?? [],
    ],
  );
  return res.rows[0].id;
}

describe('reserved arg-name prefix in a search query', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'reserved query prefix fuse') RETURNING id`,
      [PROJ_NAME],
    )).rows[0].id;

    target = await seed({
      content: '★ HANDOFF — the record a correct id lookup must return',
      type: 'handoff',
      tags: [TAG_TARGET, TASK_TAG],
    });

    // Noise rows that DO match the meaningless-hex direction: they are what a degraded
    // `id:<uuid>` query used to return instead of the target.
    for (let i = 0; i < 4; i++) {
      await seed({ content: `harbor vessel pilot log entry ${i}` });
    }
  });

  afterAll(async () => {
    if (!projectId) return;
    try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
  });

  // ── PART B: the reserved prefixes now FAIL LOUD ────────────────────────────────────────

  describe('a <argName>:<value> query is a loud error, not silent degradation', () => {
    test('every configured reserved prefix errors through the real public tool path', async () => {
      // Guard the guard: if the config were emptied this whole describe would be a no-op.
      expect(reservedFor('context_search').length).toBeGreaterThan(0);
      expect(reservedFor('context_search')).toEqual(['id', 'type', 'tags']);

      for (const name of reservedFor('context_search')) {
        const query = `${name}:071df00d-640a-485b-a1c8-7df2c783a67e`;
        const resp: any = await viaPublicTool({ query, projectId, limit: 20 });

        expect(resp.isError, `"${query}" must be an ERROR, not a result set`).toBe(true);
        expect(resp.structuredContent.ok).toBe(false);
        expect(resp.structuredContent.error).toBe('reserved_query_prefix');
        expect(resp.structuredContent.reservedArg).toBe(name);

        // It must not smuggle results back alongside the error.
        expect(rows(resp)).toEqual([]);

        // The message must be ACTIONABLE: name the parameter and show the parameter form.
        const t = text(resp);
        expect(t).toContain(`\`${name}\` is a PARAMETER`);
        expect(t).toContain('no key:value query language');
        expect(t).toMatch(new RegExp(`${name}\\s*=`));
      }
    });

    test('the id: case returns the ERROR rather than the unrelated record the bug returned', async () => {
      // THE ORIGINAL DEFECT, end to end. Before the fix this returned noise rows ranked as
      // an answer. It must now be an error that carries NO results at all.
      const resp: any = await viaPublicTool({
        query: `id:${target}`,
        projectId,
        limit: 20,
      });
      expect(resp.isError).toBe(true);
      expect(rows(resp)).toEqual([]);
      // And it must NOT have quietly resolved the id either — Part C: error, never resolve.
      expect(resp.structuredContent.total).toBeUndefined();
    });

    test('the error message ECHOES the value so the caller can copy it into the parameter', async () => {
      const resp: any = await viaPublicTool({ query: 'id:071df00d', projectId, limit: 20 });
      expect(text(resp)).toContain('id = "071df00d"');
    });

    test('tags: is steered to the ARRAY form, not a bare scalar', () => {
      expect(reservedArgPrefixMessage('tags', 'tags:ref:cp-gaps', 'context_search')).toContain('tags = ["ref:cp-gaps"]');
    });

    test('matching is case-insensitive on the arg NAME', () => {
      expect(reservedArgPrefixInQuery('ID:071df00d', 'context_search')).toBe('id');
      expect(reservedArgPrefixInQuery('Type:handoff', 'context_search')).toBe('type');
    });

    test('the guard sits AHEAD of every searching branch (tags supplied alongside a bad query)', async () => {
      // A reserved-prefix query must not slip through on a branch that also got tags.
      const resp: any = await viaPublicTool({
        query: 'id:071df00d',
        tags: [TAG_TARGET],
        projectId,
        limit: 20,
      });
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.error).toBe('reserved_query_prefix');
    });

    test('a CORRECT id call is never blocked, even with a stray query alongside it', async () => {
      // The guard is placed AFTER the by-id branch on purpose: a caller who supplies the
      // real `id` parameter gets their record, not a lecture.
      const resp: any = await viaPublicTool({ id: target, query: 'id:whatever', projectId });
      expect(resp.isError).toBeFalsy();
      expect(rows(resp)[0].id).toBe(target);
    });
  });

  // ── THE LINE THIS MUST NOT CROSS: tag-grammar prefixes keep working ─────────────────────

  describe('tag-grammar prefixes are NOT reserved and keep working as free-text queries', () => {
    test('the pre-existing contract holds: queryLooksLikeId("ref:res") === false', () => {
      // The fuse from an earlier task. The bare-token design is deliberate; this fix must not
      // have turned queryLooksLikeId into a key:value parser.
      expect(queryLooksLikeId('ref:res')).toBe(false);
    });

    test('none of the tag-grammar prefixes trips the reserved guard', () => {
      expect(SEARCH_PROTECTED_TAG_GRAMMAR_PREFIXES.length).toBeGreaterThan(0);
      // Across EVERY guarded tool, not just context_search — a sibling that reserved `ref:`
      // would break the boot ritual just as thoroughly.
      const guardedTools = Object.keys(RESERVED_QUERY_PREFIXES_EFFECTIVE);
      expect(guardedTools).toEqual(['context_search', 'decision_search', 'smart_search']);
      for (const tool of guardedTools) {
        for (const p of SEARCH_PROTECTED_TAG_GRAMMAR_PREFIXES) {
          expect(
            reservedArgPrefixInQuery(`${p}:something`, tool),
            `${p}: must stay queryable on ${tool}`,
          ).toBeNull();
        }
      }
      // The config guard that keeps it that way is real, not decorative: no protected
      // prefix may appear in the reserved list.
      for (const tool of guardedTools) {
        for (const p of SEARCH_PROTECTED_TAG_GRAMMAR_PREFIXES) {
          expect(reservedFor(tool), `${tool} must not reserve ${p}`).not.toContain(p);
        }
      }
    });

    test('`ref:resume` as a QUERY still reaches the tagged record (the boot ritual)', async () => {
      const resp: any = await viaPublicTool({ query: 'ref:resume', projectId, limit: 20 });
      expect(resp.isError).toBeFalsy();
      expect(rows(resp).some((c) => c.id === target)).toBe(true);
    });

    test('`task:<id8>` as a QUERY still reaches the tagged record', async () => {
      const resp: any = await viaPublicTool({ query: TASK_TAG, projectId, limit: 20 });
      expect(resp.isError).toBeFalsy();
      expect(rows(resp).some((c) => c.id === target)).toBe(true);
    });

    test('the env override CANNOT reserve a tag-grammar prefix — it throws LOUD', async () => {
      // GUARD THE GUARD. The reserved list is env-tunable, which makes the
      // config itself an attack surface on the boot ritual: reserving `ref` would turn
      // `ref:resume` into a hard error. The config must REFUSE, loudly — a silent drop
      // would be allow-by-default (you'd think you configured something you didn't).
      //
      // Dynamic import AFTER stubbing env + resetting modules: searchConfig memoizes at
      // module load, so a static import would evaluate before the stub.
      vi.stubEnv('SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH', 'id,type,tags,ref');
      vi.resetModules();
      await expect(import('../config/searchConfig.js')).rejects.toThrow(/may not reserve tag-grammar prefixes/);

      // And the happy path still loads with a custom-but-legal list.
      vi.stubEnv('SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH', 'id,limit');
      vi.resetModules();
      const mod = await import('../config/searchConfig.js');
      expect(Object.keys(mod.RESERVED_QUERY_PREFIXES_EFFECTIVE.context_search)).toEqual(['id', 'limit']);

      vi.unstubAllEnvs();
      vi.resetModules();
    });

    test('a METACHARACTER name cannot smuggle past the tag-grammar protection', async () => {
      // THE REVIEWER BLOCKER. The name used to be interpolated into
      // `new RegExp()` UNESCAPED while the protection compared LITERAL strings — so a
      // metacharacter name slipped past the literal check and then matched as a PATTERN.
      // REPRODUCED before the fix: with '[a-z]+', the module loaded fine and
      // reservedArgPrefixInQuery('ref:resume') returned '[a-z]+' instead of null — i.e.
      // `ref:resume` became a hard error and the BOOT RITUAL broke. That is precisely the
      // outcome PROTECTED_TAG_GRAMMAR_PREFIXES exists to make impossible.
      //
      // LAYER 1 — the shape gate now fails CLOSED at module load, before anything can match.
      for (const bad of ['[a-z]+', '.*', 'id,[', '^id', 'i.', 'id|ref']) {
        vi.stubEnv('SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH', bad);
        vi.resetModules();
        await expect(
          import('../config/searchConfig.js'),
          `env='${bad}' must fail closed at load`,
        ).rejects.toThrow(/invalid reserved-prefix name/);
      }
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    test('LAYER 2: the matcher compares the name LITERALLY, never as a pattern', () => {
      // Defense in depth — proves the guard is correct even if an unvalidated name ever
      // reached the matcher (the config gate means the public API can no longer deliver one,
      // which would otherwise leave this layer unproven).
      //
      // THIS ASSERTION IS THE ONE THAT WOULD HAVE CAUGHT TODAY'S BUG: under the old
      // regex-from-name matcher, /^[a-z]+\s*:\s*\S+$/i.test('ref:resume') === true, so this
      // returned the reserved name and the boot ritual broke.
      for (const meta of ['[a-z]+', '.*', '^ref', 'r.f', 'ref|task']) {
        expect(
          matchesReservedPrefix('ref:resume', meta),
          `metacharacter name "${meta}" must NOT match ref:resume as a pattern`,
        ).toBe(false);
        expect(matchesReservedPrefix('task:4d13f00d', meta)).toBe(false);
      }

      // NOT VACUOUS: the matcher really does match — literally, and case-insensitively.
      expect(matchesReservedPrefix('ref:resume', 'ref')).toBe(true);
      expect(matchesReservedPrefix('ID:071df00d', 'id')).toBe(true);

      // A malformed name is inert, NOT a per-call SyntaxError (the old second symptom:
      // env='id,[' threw at REQUEST time inside the route try/catch instead of at boot).
      expect(() => matchesReservedPrefix('harbor vessel notes', '[')).not.toThrow();
      expect(matchesReservedPrefix('harbor vessel notes', '[')).toBe(false);
    });

    test('the load-time error names the ACTUAL source (code table vs the env var)', async () => {
      // A message that always blames the env var sends the next debugger to the wrong place.
      vi.stubEnv('SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH', 'id,ref');
      vi.resetModules();
      await expect(import('../config/searchConfig.js')).rejects.toThrow(
        /SEARCH_RESERVED_QUERY_PREFIXES__CONTEXT_SEARCH \(env override\)/,
      );
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    test('ordinary PROSE containing a colon is not caught (the false-positive line)', () => {
      // The guard requires a single whitespace-free token after the colon, precisely so a
      // genuine search like this stays a search. A false positive here blocks real work.
      expect(reservedArgPrefixInQuery('type: what does this field mean', 'context_search')).toBeNull();
      expect(reservedArgPrefixInQuery('notes on id: the resolver design', 'context_search')).toBeNull();
      expect(reservedArgPrefixInQuery('rapid: a study', 'context_search')).toBeNull();
      // Not anchored at the start → not the misuse shape.
      expect(reservedArgPrefixInQuery('see id:071df00d for details', 'context_search')).toBeNull();
      // Empty value → nothing to steer them to, so not caught.
      expect(reservedArgPrefixInQuery('id:', 'context_search')).toBeNull();
      expect(reservedArgPrefixInQuery(undefined, 'context_search')).toBeNull();
    });
  });

  // ── THE CAPABILITY ITSELF IS UNTOUCHED ────────────────────────────────────────────────

  describe('the id PARAMETER (the correct call) still resolves', () => {
    test('a FULL UUID resolves to the exact record', async () => {
      const resp: any = await viaPublicTool({ id: target, projectId });
      expect(resp.isError).toBeFalsy();
      const r = rows(resp);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe(target);
    });

    test('an 8-char SHORT id resolves to the exact record', async () => {
      const resp: any = await viaPublicTool({ id: target.slice(0, 8), projectId });
      expect(resp.isError).toBeFalsy();
      const r = rows(resp);
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe(target);
    });

    test('a BARE token query still hits the id-prefix gate (no DSL needed, by design)', async () => {
      const prefix = target.slice(0, 8);
      expect(queryLooksLikeId(prefix)).toBe(true);
      const resp: any = await viaPublicTool({ query: prefix, projectId, limit: 20 });
      expect(resp.isError).toBeFalsy();
      // The whole point of the bare-token design: the target ranks #1 via the id boost even
      // though it is the WORST semantic match in this corpus.
      expect(rows(resp)[0].id).toBe(target);
    });
  });

  // ── THE SWEEP: the SIBLING search tools carry the same class ──────────────────────────

  describe('sibling search tools are guarded by the SAME mechanism', () => {
    // A fix applied to one instance while its siblings stay exposed is a partially-applied
    // fix — the shape that makes a bug look like it "recurs". decision_search and
    // smart_search share context_search's degradation, so they share its guard.

    test('decision_search rejects a reserved-prefix query through its real route', async () => {
      const resp: any = await decisionsRoutes.handleSearch({
        query: 'id:071df00d-640a-485b-a1c8-7df2c783a67e',
        projectId,
      });
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.error).toBe('reserved_query_prefix');
      expect(resp.structuredContent.reservedArg).toBe('id');
    });

    test('smart_search rejects a reserved-prefix query through its real route', async () => {
      const resp: any = await searchRoutes.handleSmartSearch({
        query: 'id:071df00d-640a-485b-a1c8-7df2c783a67e',
        projectId,
      });
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.error).toBe('reserved_query_prefix');
      expect(resp.structuredContent.reservedArg).toBe('id');
    });

    test('the REMEDY is tool-correct — it never names a parameter the tool does not have', () => {
      // THE POINT OF PER-TOOL CONFIG. context_search HAS an `id` parameter; decision_search
      // and smart_search do NOT. Telling a decision_search caller to "use the id parameter"
      // would earn them a strict-mode rejection — a confidently WRONG instruction, which is
      // the very "product teaches the misread" failure this task exists to kill.
      const ctxMsg = reservedArgPrefixMessage('id', 'id:071df00d', 'context_search');
      expect(ctxMsg).toContain('id = "071df00d"');
      expect(ctxMsg).not.toContain('Drop the prefix');

      for (const tool of ['decision_search', 'smart_search']) {
        const msg = reservedArgPrefixMessage('id', 'id:071df00d', tool);
        expect(msg, `${tool} must steer to the BARE token`).toContain('Drop the prefix');
        expect(msg).toContain('query = "071df00d"');
        expect(msg, `${tool} has no id parameter — must not advertise one`)
          .toContain('has no `id` parameter');
      }
    });

    test('decision_search steers `type:` to its REAL parameter name (decisionType)', () => {
      const msg = reservedArgPrefixMessage('type', 'type:architecture', 'decision_search');
      expect(msg).toContain('decisionType = "architecture"');
    });

    test('smart_search steers `type:` to includeTypes, in ARRAY form', () => {
      const msg = reservedArgPrefixMessage('type', 'type:context', 'smart_search');
      expect(msg).toContain('includeTypes = ["context"]');
    });

    test('an UNGUARDED tool is never guessed at rather than given another tool\'s rules', () => {
      // toolName is required and unknown tools return null — a default would silently apply
      // context_search\'s (possibly wrong) remedy to a new call site.
      expect(reservedArgPrefixInQuery('id:071df00d', 'task_list')).toBeNull();
      expect(reservedArgPrefixInQuery('id:071df00d', 'nope_not_a_tool')).toBeNull();
    });

    test('tag-grammar queries still work on the sibling tools too', async () => {
      for (const tool of ['decision_search', 'smart_search']) {
        expect(reservedArgPrefixInQuery('ref:resume', tool)).toBeNull();
        expect(reservedArgPrefixInQuery('task:4d13f00d', tool)).toBeNull();
      }
      // And end-to-end through the real decision route (must not error).
      const resp: any = await decisionsRoutes.handleSearch({ query: 'ref:resume', projectId });
      expect(resp.isError).toBeFalsy();
    });
  });

  // ── THE GATEWAY SURFACE (the one Coordinator + customers actually get) ──────────────────────

  describe('the guard holds end-to-end on the GATEWAY surface', () => {
    // WHY THIS IS NOT REDUNDANT WITH THE FLAT TESTS. "It routes through the same handler" is a
    // WEAKER guarantee on the gateway than it looks: the gateway path demonstrably MUTATES
    // arguments in transit before they reach the handler. Our guard reads `query`, which
    // should be untouched — but "should be" is not proof, and this is the default customer
    // surface.
    //
    // The real protocol path is:
    //   tools/call → executeMcpTool
    //              → dispatchGateway (gateway names) | routeExecutor (always-flat names)
    //              → validateToolArguments  ← argument transit/coercion happens HERE
    // so we exercise BOTH halves rather than asserting from the call graph.
    //
    // SEAM MOVED. This assertion originally drove
    // `MandrelMcpServer.deserializeParameters` — a hardcoded NAME ALLOW-LIST that was the
    // transit-mutation point at the time. That function is GONE: it could never have been
    // correct for a gateway call, because at that seam the op is not yet resolved (the tool
    // is still named `context`/`task`), so the per-op schema that says what each param should
    // be does not exist there. Coercion is now SCHEMA-DRIVEN and lives in
    // `validateToolArguments` (middleware/validation.ts). The CONTRACT under test is
    // unchanged — "a declared-string param survives argument transit byte-identical while
    // other params coerce" — so this test was translated to the new seam, not weakened.

    const GW_CONN = `gw-${STAMP}`;

    test('argument transit leaves `query` byte-identical (the transit-mutation risk)', () => {
      // Drive the REAL seam — validateToolArguments is what every op crosses on every
      // transport (flat via validationMiddleware, gateway via dispatchGateway). Pure: no DB,
      // no listener.
      //
      // `query` is a DECLARED STRING, so schema-driven coercion is structurally out of scope
      // for it and it must survive untouched. THE INPUTS ARE CHOSEN TO TRIP EACH COERCION
      // ARM — an earlier revision of this test used only id:-shaped strings and MUTATION-
      // PROBED GREEN when `query` was added to arrayParams, i.e. it proved nothing
      // (a check whose inputs can't trigger the transform is an allow-list, not a
      // guard). So every probe below actually LOOKS LIKE a coercible type: the array arm
      // fires only on a real JSON array, the object arm only on a real JSON object, the
      // boolean arm only on the documented boolean vocabulary.
      const adversarial = [
        // — trips the ARRAY arm if `query` were ever treated as an array —
        '["ref:resume"]',
        '[1,2,3]',
        // — trips the NUMBER arm —
        '12345678',
        '071',                      // a leading zero must not be normalised away
        // — trips the BOOLEAN arm (new arms exist since the seam moved) —
        'true',
        // — trips the OBJECT arm —
        '{"k":"v"}',
        // — realistic misuse + integrity cases —
        'id:071df00d-640a-485b-a1c8-7df2c783a67e',
        'tags:["ref:cp-gaps"]',
        '  id:071df00d  ',          // whitespace must NOT be trimmed away in transit
        'ref:resume — naïve ünïcode',
      ];

      for (const q of adversarial) {
        // GUARD THE GUARD, FUSED INTO EVERY ITERATION. `limit` and `tags` ride along in the
        // SAME call and MUST coerce. This is the anti-inertness half: if coercion were ever
        // disabled wholesale, the `query` assertions would pass vacuously and this test would
        // be theatre — so we prove, in the same breath, that coercion is live and simply does
        // not apply to a declared string.
        const out = validateToolArguments('context_search', {
          query: q,
          limit: '5',
          tags: '["ref:resume"]',
        });

        expect(out.query, `argument transit altered the query "${q}"`).toBe(q);
        expect(typeof out.query, `argument transit retyped the query "${q}"`).toBe('string');

        expect(out.limit, `coercion went inert (limit) while probing "${q}"`).toBe(5);
        expect(out.tags, `coercion went inert (tags) while probing "${q}"`).toEqual(['ref:resume']);
      }
    });

    test('context gateway: a reserved-prefix query errors with the PARAMETER remedy', async () => {
      const resp: any = await dispatchGateway(
        'context',
        { action: 'search', query: `id:${target}`, projectId },
        { connectionId: GW_CONN },
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.error).toBe('reserved_query_prefix');
      expect(resp.structuredContent.reservedArg).toBe('id');
      // context_search HAS an `id` parameter → parameter remedy, not the bare-token one.
      expect(responseText(resp)).toContain(`id = "${target}"`);
      expect(responseText(resp)).not.toContain('Drop the prefix');
    });

    test('decision gateway: the same query errors with the BARE-TOKEN remedy', async () => {
      const resp: any = await dispatchGateway(
        'decision',
        { action: 'search', query: 'id:071df00d', projectId },
        { connectionId: GW_CONN },
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.error).toBe('reserved_query_prefix');
      // decision_search has NO `id` parameter — the remedy must differ from context's.
      expect(responseText(resp)).toContain('Drop the prefix');
      expect(responseText(resp)).toContain('query = "071df00d"');
    });

    test('smart_search is NOT gateway-folded — it is guarded on its always-flat route', async () => {
      // FINDING worth pinning: smart_search is kind:'flat' in the registry (alongside
      // recall_thread / get_recommendations), so on the MCP-protocol surface it is still
      // called by its FLAT name and never passes through dispatchGateway. Its protocol path
      // is routeExecutor — so that is where its guard has to hold.
      const op = OP_REGISTRY.find((o) => o.opId === 'smart_search');
      expect(op!.kind).toBe('flat');

      const resp: any = await routeExecutor(
        'smart_search',
        { query: 'id:071df00d', projectId },
        { connectionId: GW_CONN },
      );
      expect(resp.isError).toBe(true);
      expect(resp.structuredContent.error).toBe('reserved_query_prefix');
      expect(responseText(resp)).toContain('Drop the prefix');
    });

    test('THE BOOT RITUAL survives the gateway: ref:resume + task:<id8> still SEARCH', async () => {
      // If the gateway broke this we would lose the documented way to resume a session.
      for (const q of ['ref:resume', TASK_TAG]) {
        const resp: any = await dispatchGateway(
          'context',
          { action: 'search', query: q, projectId, limit: 20 },
          { connectionId: GW_CONN },
        );
        expect(resp.isError, `"${q}" must SEARCH through the gateway, not error`).toBeFalsy();
        expect(
          rows(resp).some((c: any) => c.id === target),
          `"${q}" must still reach the tagged record through the gateway`,
        ).toBe(true);
      }
    });

    test('the gateway does not alter the query string in transit (exact echo)', async () => {
      // Any encoding/coercion/trimming introduced anywhere on the gateway path would show up
      // as a mismatch between what we sent and what the error echoes back.
      const sent = 'id:071df00d-640a-485b-a1c8-7df2c783a67e';
      const resp: any = await dispatchGateway(
        'context',
        { action: 'search', query: sent, projectId },
        { connectionId: GW_CONN },
      );
      expect(resp.structuredContent.query).toBe(sent);
      expect(responseText(resp)).toContain(`"${sent}"`);
    });

    test('a CORRECT gateway id call still resolves (the guard did not break the good path)', async () => {
      // The shape from the live P0 report: id as an ARGUMENT, short 8-char form.
      const resp: any = await dispatchGateway(
        'context',
        { action: 'search', id: target.slice(0, 8), projectId },
        { connectionId: GW_CONN },
      );
      expect(resp.isError).toBeFalsy();
      expect(rows(resp)).toHaveLength(1);
      expect(rows(resp)[0].id).toBe(target);
    });
  });

  // ── PART A: nothing advertises the broken notation any more ───────────────────────────

  describe('the advertised notation cannot teach the misread', () => {
    /** The exact shape that caused the bug: `<tool> <arg>:<value>` read as query syntax. */
    const TOOL_ARG_COLON_RE = /\b(context_search|decision_search|task_list|smart_search)\s+\w+:/;

    test('the truncation affordance names the id PARAMETER and is surface-neutral', () => {
      // RE-POINTED at the LIVE clipper (SEARCH P3 round 2). This asserted
      // through applyRecallPayload, which this round DELETED (zero production callers); the PROPERTY it
      // guards — the notation of the affordance context_search actually emits — is very much
      // alive, it just moved to recallSnippetBudget + the shared clipBody. Deleting the test
      // with the dead function would have dropped a live property, which is precisely the
      // mistake this round exists to correct.
      //
      // +400, not +1: clipBody refuses a clip that would not SHRINK (the affordance costs
      // ~75 chars), so an over-by-one body comes back WHOLE and emits no affordance at all.
      // The overrun has to clear the affordance's own cost for one to be emitted.
      const budget = recallSnippetBudget('abc12345');
      const clipped = clipBody('x'.repeat(RECALL_CONCISE_MAXLEN + 400), budget);
      expect(clipped.omittedChars).toBeGreaterThan(0);
      const over = { content: clipped.text };

      // It must steer to the parameter...
      expect(over.content).toContain('id parameter');
      expect(over.content).toContain('id="abc12345"');
      // ...and must NOT contain the `tool arg:value` form that taught the misread.
      expect(over.content).not.toMatch(TOOL_ARG_COLON_RE);
      // Surface-neutral: naming a specific tool makes it wrong on the other surface.
      expect(over.content).not.toContain('context_search');
      expect(over.content).not.toContain('context(');
    });

    test('the affordance it emits is not itself a query the tool would now REJECT', async () => {
      // THE SELF-CONSISTENCY FUSE. If the affordance ever advertises something that
      // reservedArgPrefixInQuery rejects, the product is telling agents to make a call it
      // will refuse. Extract every `word:token` from the affordance and prove none is reserved.
      const clipped = clipBody('x'.repeat(RECALL_CONCISE_MAXLEN + 400), recallSnippetBudget('abc12345'));
      expect(clipped.omittedChars).toBeGreaterThan(0); // the affordance was really emitted
      const over = { content: clipped.text };
      const pairs = over.content.match(/\b\w+:\S+/g) ?? [];
      for (const p of pairs) {
        for (const tool of Object.keys(RESERVED_QUERY_PREFIXES_EFFECTIVE)) {
          expect(
            reservedArgPrefixInQuery(p, tool),
            `affordance advertises a query ${tool} would reject: "${p}"`,
          ).toBeNull();
        }
      }
    });

    test('EVERY guarded tool documents the rejection in its own query description', () => {
      // FAIL-CLOSED COVERAGE. A tool that ERRORS on `name:value` must SAY so on
      // the surface an agent actually reads, or the guard is a trap. This is deny-by-default:
      // it iterates the guard config itself, so adding a 4th guarded tool without documenting
      // it turns this RED — it can never silently pass on a tool it does not recognize.
      const guarded = Object.keys(RESERVED_QUERY_PREFIXES_EFFECTIVE);
      expect(guarded.length).toBeGreaterThan(0);

      for (const tool of guarded) {
        const op = OP_REGISTRY.find((o) => o.opId === tool);
        expect(op, `guarded tool ${tool} is not in the registry`).toBeDefined();
        const desc = (op!.humanDescriptions as Record<string, string> | undefined)?.query;
        expect(desc, `guarded tool ${tool} has no query description to warn in`).toBeTruthy();
        expect(desc, `${tool} rejects key:value queries but never says so`)
          .toMatch(/NO key:value query syntax/);
      }
    });

    test('no context_search schema description advertises the tool-arg-colon form', () => {
      const op = OP_REGISTRY.find((o) => o.opId === 'context_search');
      expect(op, 'context_search must exist in the registry').toBeDefined();

      const descriptions = [
        op!.description,
        ...Object.values(op!.humanDescriptions ?? {}),
      ].filter((d): d is string => typeof d === 'string');

      // Guard the guard: if the registry shape changed and we scanned nothing, fail loud
      // rather than pass vacuously (a past incident — a coverage check must fail closed).
      expect(descriptions.length).toBeGreaterThan(5);

      for (const d of descriptions) {
        expect(d, `schema description still teaches the broken notation: "${d}"`)
          .not.toMatch(TOOL_ARG_COLON_RE);
      }
    });
  });
});
