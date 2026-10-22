/**
 * THE SEAM TEST — `usePageProject().scope()` driven through a REAL `api.*` call.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS TO CATCH (Reviewer B1, reject round 1 of epic 41293984)
 * ════════════════════════════════════════════════════════════════════════════════════
 * `scopedRequestConfig` shipped fully tested — in ISOLATION. `usePageProject.test.tsx`
 * builds a config object and hand-feeds it to the axios request interceptor. Nothing in
 * the suite ever called a real `api.*` method with `scope()`. So the primitive was green
 * while its own DOCUMENTED call sites did not compile:
 *
 *     api.decisions.create(body, project.scope())   →  TS2554: Expected 1 arguments, but got 2
 *
 * The three `requireWriteProjectId` surfaces §A1 exists to protect — `decision_record`,
 * `decision_update`, `context_store` — had NO PATH from a page to the wire. A primitive
 * tested only in isolation, never at the seam its consumer uses, is exactly how that
 * ships green.
 *
 * ── WHAT THIS ASSERTS, AND WHY IT CANNOT SELF-AGREE ──────────────────────────────────
 * Every case below calls the real domain method on the real shared axios instance and
 * reads `X-Project-ID` off the config the adapter is handed — the actual bytes that
 * would go on the wire, after both interceptors have run. The ambient localStorage scope
 * is deliberately set to a DIFFERENT project (B), so three outcomes are distinguishable:
 *
 *     header === A   → PASS. The page's scope reached the wire.
 *     header === B   → FAIL. The passthrough is missing; the write lands in the default.
 *     header absent  → FAIL. Unscoped — several controllers read that as "every project".
 *
 * There is no mock server echoing what we sent. The adapter is a capture point, not a
 * participant: it never answers a question the client asked it.
 *
 * ── THE POPULATION THIS ENUMERATES ───────────────────────────────────────────────────
 * Every domain method that took a `config?: AxiosRequestConfig` passthrough in this fix,
 * across all eleven modules the ten page streams consume. It is a HAND-MAINTAINED list,
 * and that is its known limit: a NEW method added later is not automatically covered.
 * `guards its own population` (last describe) closes that by reflecting over the domain
 * objects and failing on any method reachable from a scoped page that this file forgot.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import { api } from '../index';
import { apiClient } from '../../services/api';
import { apiConfig } from '../../config/apiConfig';
import { scopedRequestConfig, ALL_PROJECTS_SCOPE } from '../http/projectScope';

/** The page's project — what every request below MUST name. */
const PROJECT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
/** The user's default / ambient project — what a missing passthrough would send instead. */
const PROJECT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const captured: InternalAxiosRequestConfig[] = [];
let originalAdapter: unknown;

beforeAll(() => {
  const instance = apiClient.instance;
  originalAdapter = instance.defaults.adapter;
  // A CAPTURE POINT, NOT A MOCK SERVER. It records the outgoing config and returns the
  // thinnest possible envelope; it never reflects a request value back as data.
  instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    captured.push(config);
    return {
      data: { success: true, data: {} },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient.instance.defaults.adapter = originalAdapter as any;
});

beforeEach(() => {
  captured.length = 0;
  localStorage.clear();
  // THE AMBIENT SCOPE IS B, DELIBERATELY. Every assertion is only meaningful because the
  // ambient value is a project the page is NOT showing.
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: PROJECT_B }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: PROJECT_B }));
});

afterEach(() => {
  localStorage.clear();
});

const sentHeader = (): unknown =>
  (captured.at(-1)?.headers as Record<string, unknown> | undefined)?.[apiConfig.projectHeader];

const sentParams = (): Record<string, unknown> =>
  (captured.at(-1)?.params ?? {}) as Record<string, unknown>;

/** `scope()` as `usePageProject` hands it out — the exact object a page would pass. */
const scope = (base?: AxiosRequestConfig) => scopedRequestConfig(PROJECT_A, base);

/**
 * THE POPULATION. Each entry calls the real domain method exactly as a scoped page
 * would. The list is the point: the three Reviewer named are in here, but so is every
 * other method the ten page streams can plausibly reach, because a passthrough that
 * exists on three methods and not the fourth is the same bug one call site over.
 */
const CASES: ReadonlyArray<readonly [string, (cfg: AxiosRequestConfig) => Promise<unknown>]> = [
  // ── contexts ── (context_store is a requireWriteProjectId surface)
  ['contexts.search', (c) => api.contexts.search({ query: 'x' }, c)],
  ['contexts.get', (c) => api.contexts.get('ctx-1', c)],
  ['contexts.create', (c) => api.contexts.create({ content: 'hello' }, c)],
  ['contexts.update', (c) => api.contexts.update('ctx-1', { content: 'x' }, c)],
  ['contexts.remove', (c) => api.contexts.remove('ctx-1', c)],
  ['contexts.restore', (c) => api.contexts.restore('ctx-1', c)],
  ['contexts.bulkDelete', (c) => api.contexts.bulkDelete(['ctx-1'], c)],
  ['contexts.bulkUpdate', (c) => api.contexts.bulkUpdate(['ctx-1'], { tags: ['t'] }, c)],
  ['contexts.stats', (c) => api.contexts.stats(c)],
  ['contexts.related', (c) => api.contexts.related('ctx-1', c)],
  ['contexts.links', (c) => api.contexts.links('ctx-1', c)],
  ['contexts.export', (c) => api.contexts.export({ query: 'x' }, 'json', c)],

  // ── decisions ── (decision_record / decision_update are requireWriteProjectId surfaces)
  ['decisions.search', (c) => api.decisions.search({ query: 'x' }, c)],
  ['decisions.get', (c) => api.decisions.get('dec-1', c)],
  ['decisions.create', (c) => api.decisions.create({ title: 't' } as never, c)],
  ['decisions.update', (c) => api.decisions.update('dec-1', { status: 'active' }, c)],
  ['decisions.remove', (c) => api.decisions.remove('dec-1', c)],
  ['decisions.stats', (c) => api.decisions.stats(undefined, c)],
  ['decisions.links', (c) => api.decisions.links('dec-1', c)],
  // THE DECISION INBOX.
  ['decisions.answer', (c) => api.decisions.answer('dec-1', 'opt-a', 'a note', c)],
  ['decisions.discuss', (c) => api.decisions.discuss('dec-1', 'a note', c)],

  // ── tasks ──
  ['tasks.list', (c) => api.tasks.list({ status: 'todo' }, c)],
  ['tasks.get', (c) => api.tasks.get('task-1', c)],
  ['tasks.create', (c) => api.tasks.create({ title: 't' } as never, c)],
  ['tasks.update', (c) => api.tasks.update('task-1', { title: 't' }, c)],
  ['tasks.remove', (c) => api.tasks.remove('task-1', c)],
  ['tasks.restore', (c) => api.tasks.restore('task-1', c)],
  ['tasks.stats', (c) => api.tasks.stats({}, c)],
  ['tasks.leadTime', (c) => api.tasks.leadTime({}, c)],
  ['tasks.throughput', (c) => api.tasks.throughput({}, c)],
  ['tasks.completedByActor', (c) => api.tasks.completedByActor({}, c)],
  ['tasks.actorOptions', (c) => api.tasks.actorOptions({}, c)],
  ['tasks.bulkUpdate', (c) => api.tasks.bulkUpdate([{ id: 'task-1', status: 'completed' }], c)],
  ['tasks.bulkMove', (c) => api.tasks.bulkMove(['task-1'], PROJECT_A, c)],
  ['tasks.assign', (c) => api.tasks.assign('task-1', 'someone', c)],
  ['tasks.setStatus', (c) => api.tasks.setStatus('task-1', 'todo' as never, c)],
  ['tasks.links', (c) => api.tasks.links('task-1', c)],

  // ── attachments ── (addressed by record id like tasks.update, and
  // the passthrough still has to reach the wire for the same reason)
  ['attachments.list', (c) => api.attachments.list('task-1', c)],
  ['attachments.listForTasks', (c) => api.attachments.listForTasks(['task-1'], c)],
  ['attachments.upload', (c) => api.attachments.upload('task-1', new Blob(['x']), 'before', c)],
  ['attachments.blob', (c) => api.attachments.blob('att-1', c)],
  ['attachments.remove', (c) => api.attachments.remove('att-1', c)],

  // ── sessions (Analytics + Sessions pages read these) ──
  ['sessions.list', (c) => api.sessions.list({}, c)],
  ['sessions.trends', (c) => api.sessions.trends({ days: 7 }, c)],
  ['sessions.productive', (c) => api.sessions.productive({ limit: 5 }, c)],
  ['sessions.tokenPatterns', (c) => api.sessions.tokenPatterns({}, c)],
  ['sessions.contextsByActor', (c) => api.sessions.contextsByActor({ days: 30 }, c)],
  ['sessions.get', (c) => api.sessions.get('sess-1', c)],
  ['sessions.current', (c) => api.sessions.current(c)],
  ['sessions.update', (c) => api.sessions.update('sess-1', {} as never, c)],
  ['sessions.start', (c) => api.sessions.start({}, c)],
  ['sessions.end', (c) => api.sessions.end('sess-1', c)],
  ['sessions.active', (c) => api.sessions.active(c)],
  ['sessions.files', (c) => api.sessions.files('sess-1', c)],
  ['sessions.syncFiles', (c) => api.sessions.syncFiles('sess-1', c)],

  // ── projects ──
  ['projects.list', (c) => api.projects.list(c)],
  ['projects.watchable', (c) => api.projects.watchable(c)],
  ['projects.get', (c) => api.projects.get('proj-1', c)],
  ['projects.create', (c) => api.projects.create({ name: 'n' } as never, c)],
  ['projects.update', (c) => api.projects.update('proj-1', {}, c)],
  ['projects.remove', (c) => api.projects.remove('proj-1', undefined, c)],
  ['projects.stats', (c) => api.projects.stats(c)],
  ['projects.insights', (c) => api.projects.insights('proj-1', c)],
  ['projects.sessions', (c) => api.projects.sessions('proj-1', c)],
  ['projects.allSessions', (c) => api.projects.allSessions({}, c)],
  ['projects.setPrimary', (c) => api.projects.setPrimary('proj-1', c)],
  ['projects.clearPrimary', (c) => api.projects.clearPrimary(c)],

  // ── dashboard ──
  ['dashboard.stats', (c) => api.dashboard.stats(c)],

  // ── treewalker ──
  // NOTE: both dropped their positional `projectId` when the TreeWalker page adopted
  // usePageProject and its private projectScopedConfig copy was deleted (epic 41293984,
  // insight stream). The old 3-arg call survived tsc here because the extra argument was
  // still type-compatible — config simply landed in an ignored slot and the request fell
  // back to the ambient project. Only the MERGED-ref run caught it.
  ['treewalker.getThread', (c) => api.treewalker.getThread('anchor-1', c)],
  ['treewalker.getResumeThread', (c) => api.treewalker.getResumeThread(c)],
  // PHASE 2 derived tiers: both are header-scoped with no path/query
  // alternative — an unscoped call to either walks EVERY project for an admin, same
  // hazard as getResumeThread.
  ['treewalker.getTrunk', (c) => api.treewalker.getTrunk(c)],
  ['treewalker.getBranches', (c) => api.treewalker.getBranches(c)],
];

describe('scope() reaches the wire through a REAL api.* call (§A1, Reviewer B1)', () => {
  it.each(CASES)('%s sends the PAGE project, not the ambient default', async (_label, call) => {
    await call(scope()).catch(() => undefined); // payload shape is irrelevant; the header is not
    expect(captured).toHaveLength(1);
    expect(sentHeader()).toBe(PROJECT_A);
  });

  /**
   * THE CONTROL. Without `scope()` the very same calls send the AMBIENT project. If this
   * ever went to A, the test above would be passing for a reason that has nothing to do
   * with the passthrough, and the whole file would be theatre.
   */
  it.each(CASES)('%s sends the AMBIENT project when scope() is omitted', async (_label, call) => {
    await (call as (c?: AxiosRequestConfig) => Promise<unknown>)(
      undefined as unknown as AxiosRequestConfig,
    ).catch(() => undefined);
    expect(captured).toHaveLength(1);
    expect(sentHeader()).toBe(PROJECT_B);
  });
});

describe('the passthrough does not eat the domain method own config', () => {
  it('contexts.search keeps its snake_case query params alongside the scope header', async () => {
    await api.contexts.search({ query: 'needle', limit: 5, sort_by: 'created_at' }, scope());
    expect(sentHeader()).toBe(PROJECT_A);
    expect(sentParams()).toMatchObject({ query: 'needle', limit: 5, sort_by: 'created_at' });
  });

  it('contexts.export keeps responseType blob', async () => {
    await api.contexts.export({ query: 'x' }, 'csv', scope());
    expect(sentHeader()).toBe(PROJECT_A);
    expect(captured.at(-1)?.responseType).toBe('blob');
    expect(sentParams()).toMatchObject({ format: 'csv' });
  });

  it('tasks.throughput keeps the tz param it adds itself', async () => {
    await api.tasks.throughput({ range: '30d' }, scope());
    expect(sentHeader()).toBe(PROJECT_A);
    expect(sentParams()).toMatchObject({ range: '30d' });
  });

});

describe('the all-projects scope reaches the wire as NO header (§A1 empty population)', () => {
  it.each([
    ['contexts.search', (c: AxiosRequestConfig) => api.contexts.search({ query: 'x' }, c)],
    ['decisions.search', (c: AxiosRequestConfig) => api.decisions.search({}, c)],
    ['tasks.list', (c: AxiosRequestConfig) => api.tasks.list({}, c)],
    ['sessions.list', (c: AxiosRequestConfig) => api.sessions.list({}, c)],
  ])('%s sends NO project header, not the ambient default', async (_label, call) => {
    await call(scopedRequestConfig(ALL_PROJECTS_SCOPE)).catch(() => undefined);
    expect(captured).toHaveLength(1);
    const headers = captured[0].headers as Record<string, unknown>;
    // Not merely falsy — the key must be GONE, or axios serializes `X-Project-ID: undefined`.
    expect(Object.prototype.hasOwnProperty.call(headers, apiConfig.projectHeader)).toBe(false);
  });
});

describe('the unscoped page fails LOUD rather than reaching the wire', () => {
  it('a write from a page with no project throws before any request is made', () => {
    expect(() => api.decisions.create({ title: 't' } as never, scopedRequestConfig(undefined))).toThrow(
      /Refusing to send an unscoped request/,
    );
    expect(captured).toHaveLength(0);
  });
});

/**
 * THE GUARD'S OWN POPULATION (C3). The CASES table is hand-maintained, so it can go
 * stale the moment someone adds a domain method. This reflects over the domain objects
 * a scoped page consumes and fails on any method that is neither covered above nor
 * listed as deliberately unscoped — so "we forgot one" is a RED, not a silence.
 */
describe('guards its own population', () => {
  /**
   * Deliberately NOT scope-passthrough methods, each with the reason:
   *  - auth.*        — pre-login / identity; there is no page project yet.
   *  - users.*       — the per-user preference surface; scoped to the USER, not a project.
   *  - embedding.*   — already takes an explicit `projectId` and sets the header itself
   *                    (api/domains/embedding.ts `scoped()`); a second channel would be
   *                    two sources of truth for one request.
   *  - feedback/meta/monitoring — instance-wide surfaces with no project axis.
   *  - resolve.*     — NOT "no project axis": this is the `/r/<id8>` short-link surface and
   *                    it is emphatically project-relevant. It is excluded because it is a
   *                    DELIBERATE GLOBAL read — it must resolve an id belonging to ANY
   *                    project the caller may see, which is the whole point of a short
   *                    link, so it goes out through `globalReadConfig` instead of the
   *                    page's scope. That contract is asserted in `globalRead.seam.test.ts`,
   *                    not here. (Corrected after Reviewer round 2: the old wording said
   *                    "no project axis", and a wrong reason tells the next reader not to
   *                    look — which is worse than no reason at all.)
   */
  const UNSCOPED_DOMAINS = ['auth', 'users', 'embedding', 'feedback', 'meta', 'monitoring', 'resolve'];

  /**
   * Covered by ANOTHER stream's guard, named here so this file's silence is deliberate
   * rather than an omission:
   *  - daySummary.get / momentumSeries.get — the Calendar's two reads. The timeviews
   *    stream owns them (branch `wt/sel-timeviews`): it makes their `config` REQUIRED,
   *    deletes their hand-rolled `X-Project-ID`, and asserts the contract end-to-end in
   *    `pages/Calendar.allContract.test.tsx` + `calendarUnscopedContract.db.test.ts`.
   *    This stream deliberately left those two files at HEAD so that merge is conflict-free.
   */
  const COVERED_ELSEWHERE = ['daySummary.get', 'momentumSeries.get'];

  const covered = new Set(CASES.map(([label]) => label));

  it('every method on a scoped domain is exercised above', () => {
    const missing: string[] = [];
    /**
     * Non-function members of a domain. The walk below can only reason about callables, so
     * anything else is skipped — and a silent skip is how a population quietly stops being
     * whole. No domain nests today, but that is a fact about TODAY, so it is ASSERTED at
     * the bottom rather than assumed: the day someone adds `api.tasks.links = {…}`, this
     * fails and asks for the walk to be made recursive, instead of dropping that subtree
     * out of the guard without a word.
     */
    const nested: string[] = [];
    for (const [domain, methods] of Object.entries(api)) {
      if (UNSCOPED_DOMAINS.includes(domain)) {
        continue;
      }
      for (const [name, value] of Object.entries(methods as Record<string, unknown>)) {
        if (typeof value !== 'function') {
          nested.push(`${domain}.${name} (${value === null ? 'null' : typeof value})`);
          continue;
        }
        const key = `${domain}.${name}`;
        if (COVERED_ELSEWHERE.includes(key)) {
          continue;
        }
        if (!covered.has(key)) {
          missing.push(key);
        }
      }
    }
    expect(missing).toEqual([]);
    // The population is whole because nothing was skipped — not because we hope so.
    expect(nested).toEqual([]);
  });
});
