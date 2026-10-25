/**
 * APPROXIMATE_SOURCES — the positive set that replaces `spineSource !== recorded`
 * (P3 build spec, section C4).
 *
 * THE DEFECT THIS FILE EXISTS TO PREVENT — and why it cannot be caught by any test written
 * against today's data. Four product sites answered "was this member's branch DERIVED
 * rather than known" with a NEGATED EQUALITY against `recorded`. Against today's two source
 * values that proxy is exactly right, so nothing can distinguish it from the correct
 * predicate. The moment P3 adds a THIRD value — `source='assigned'`, a branch a human
 * DECLARED after the fact — the proxy classifies that declared fact as an approximation:
 * `branch_history` drops `exact:false` on a branch that is perfectly exact, prints
 * "[branch inferred: pre-086 write]" against a row nobody inferred, and the briefing hangs
 * a `[spine-source:…]` caveat on it. A confident wrong number understating trust in the
 * strongest kind of fact we hold, and nothing goes red.
 *
 * So THE POPULATION UNDER TEST IS THE VALUE P3 WENT ON TO ADD, deliberately: every case
 * below drives a site with a member carrying the `'assigned'` source. When this file was
 * written that value could not be stored at all — which was the whole point, since the defect
 * had to be closed BEFORE the value existed — so each case injects it at the site's own
 * boundary rather than through the store. Migration 090 has since widened
 * `branch_memberships_source_check` to admit it, and membershipReassignment.contract.test.ts
 * exercises the same classification through the REAL store. Both are kept: this file is the
 * only one that still goes RED if a site reverts to `!== recorded` while the store happens to
 * hold no assigned row. Each case carries a legacy-approx CONTROL proving
 * the site still marks and counts what it should; without the control a passing assertion
 * would only prove the site had stopped working.
 *
 * WHAT EACH PART ACTUALLY PROVES, stated because the parts do not overlap:
 *   A — services/projectBriefing.ts `approximateMemberCount` (:221) and `renderBranchMember`
 *       (:860), through the real pure renderer. No fabrication beyond the member rows.
 *   B — services/branchMembership.ts `readBranchMembers` (:236), the count that feeds
 *       `exact`. The row reaches the real filter through an injected pool, so this is the
 *       case that genuinely exercises the classification.
 *   C — routes/branch.routes.ts, the per-member text marker (:456) and the `exact`
 *       conjunction (:556). The membership object is fabricated at the service boundary
 *       here — the route consumes `approximateMembers` as a number, so C proves the route's
 *       OWN two sites and takes B's word for where that number comes from.
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { zeroEmbedding } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: zeroEmbedding(), model: 'stub' })),
  },
}));

// PART C drives the route with a membership the store cannot yet hold. Only the ONE read is
// replaced; every other export (readBranchMemberSummaries, resolveMemberTitles, isBranchOpen)
// stays real, because the briefing and the route itself call them.
vi.mock('../services/branchMembership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/branchMembership.js')>();
  return { ...actual, readBranchMembers: vi.fn(actual.readBranchMembers) };
});

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { validateToolArguments } from '../middleware/validation.js';
import { readBranchMembers, type BranchMembership } from '../services/branchMembership.js';
import {
  renderBriefing,
  briefingConfig,
  approximateMemberCount,
  type BriefingData,
  type BriefingBranchMember,
} from '../services/projectBriefing.js';
import { NO_HANDOFF_STAMPS } from '../services/handoffStamp.js';
import { NO_CARRIED_FIELDS } from '../services/handoffCarriedFields.js';
import { censusFor } from './helpers/briefingCensus.js';
import {
  MEMBERSHIP_SOURCE,
  MEMBERSHIP_SOURCE_VALUES,
  MEMBERSHIP_SOURCE_TRUST,
  APPROXIMATE_SOURCES,
  type MembershipSource,
} from '../config/membershipSourceConfig.js';
import { resolvedHead } from './helpers/handoffHeadFixture.js';

/**
 * The fabricated corpus's ONE handoff id. Named so `handoffHead` can be DERIVED from it
 * rather than repeating the literal — a resolution naming a different id than the record
 * it is shown beside would render a header about a record the document is not serving.
 */
const FAB_HANDOFF_ID = '88888888-0000-0000-0000-000000000000';


/**
 * The declared-after-the-fact source. This was a cast to a value that did not exist when the
 * file was written; P3 declared it, so the cast is DELETED and the alias now
 * reads the real enum member — which is strictly stronger, because a renamed or removed value
 * is now a compile error here instead of a silently-still-passing string literal.
 */
const FUTURE_DECLARED_SOURCE: MembershipSource = MEMBERSHIP_SOURCE.assigned;

const STAMP = Date.now();
const SPINE_ID = '44444444-0000-0000-0000-000000000000';

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART A — the briefing renderer (projectBriefing.ts :221 and :860), pure
 * ════════════════════════════════════════════════════════════════════════════════════ */

const CFG = () => ({ ...briefingConfig(), branchScopeEnabled: true });

function fabMember(n: number, spineSource: MembershipSource): BriefingBranchMember {
  return {
    id: `33333333-0000-0000-0000-${String(n).padStart(12, '0')}`,
    type: 'context',
    headline: `MEMBER-${n} headline`,
    spineSource,
    createdAt: new Date(Date.UTC(2026, 0, 1 + n)),
  };
}

function fabBriefing(members: BriefingBranchMember[]): BriefingData {
  const branch = { spineId: SPINE_ID, members };
  return {
    projectId: '99999999-0000-0000-0000-000000000000',
    projectName: 'c4-fab',
    handoffHead: resolvedHead({ id: FAB_HANDOFF_ID }),
    handoff: {
      id: FAB_HANDOFF_ID,
      content: 'HANDOFF resume point',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      trustSignal: 'trust:unproven score:1.00',
      // No ids named in this fixture's handoff text -> nothing to stamp.
      stamps: NO_HANDOFF_STAMPS,
      // P5.4: this fixture's handoff carries no MODE/PATH prose and no stored
      // mode/spine field, so the carried-fields render is the honest empty one.
      carried: NO_CARRIED_FIELDS,
      spineResolved: null,
    },
    tasks: [],
    decisions: [],
    conventions: [],
    deadEnds: [],
    branch,
    // P5.5: no "Waiting on a human" section in this fabricated corpus — the section is
    // exercised by the waitingOnHuman contract tests. `null` says ABSENT, which is the true
    // claim here; a fabricated EMPTY section would assert a zero nobody measured.
    waiting: null,
    census: censusFor({
      tasks: [],
      decisions: [],
      conventions: [],
      deadEnds: [],
      branchMembers: members,
    }),
  };
}

/** The `- ` record lines of the branch section. */
function branchLines(markdown: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## On this branch'));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) out.push(l);
  }
  return out;
}

describe('C4 — the briefing does not caveat a DECLARED membership', () => {
  test('a recorded + assigned branch renders NO [spine-source:] marker and no approximate note', () => {
    const members = [
      fabMember(1, MEMBERSHIP_SOURCE.recorded),
      fabMember(2, FUTURE_DECLARED_SOURCE),
    ];

    // :221 — the count, called directly.
    expect(approximateMemberCount(members)).toBe(0);

    // :860 — the per-row marker, through the real renderer.
    const r = renderBriefing(fabBriefing(members), CFG());
    const lines = branchLines(r.markdown);
    expect(lines, 'both members must render, or the assertions below pass vacuously').toHaveLength(2);
    expect(lines.filter((l) => l.includes('spine-source:'))).toHaveLength(0);
    expect(r.markdown).not.toContain('APPROXIMATE members');
  });

  test('CONTROL — the same two sites still mark and count a legacy-approx member', () => {
    const members = [
      fabMember(1, MEMBERSHIP_SOURCE.recorded),
      fabMember(2, MEMBERSHIP_SOURCE.legacyApprox),
    ];
    expect(approximateMemberCount(members)).toBe(1);

    const r = renderBriefing(fabBriefing(members), CFG());
    const lines = branchLines(r.markdown);
    expect(lines.filter((l) => l.includes(`[spine-source:${MEMBERSHIP_SOURCE.legacyApprox}]`))).toHaveLength(1);
    expect(r.markdown).toContain('1 of 2 shown are APPROXIMATE members');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART B — readBranchMembers (branchMembership.ts :236), the count that feeds `exact`
 * ════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A pool that answers readBranchMembers' two queries and nothing else. The `'assigned'` row
 * has to reach the real filter to test it, and the DB CHECK will not accept one until
 * migration 089 — so the store is where the fabrication goes, and every line of the function
 * under test runs for real. Dispatched on the SQL rather than on call order: the two queries
 * are issued inside one Promise.all, where order is not something a test may assume.
 */
function stubPool(rows: Array<Record<string, unknown>>, tagOnly: number): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM branch_membership bm')) return { rows };
      if (sql.includes('FROM links l')) return { rows: [{ n: tagOnly }] };
      throw new Error(`stubPool received an unexpected query: ${sql.slice(0, 80)}`);
    },
  } as unknown as Pool;
}

function stubRow(n: number, spineSource: MembershipSource): Record<string, unknown> {
  return {
    member_id: `55555555-0000-0000-0000-${String(n).padStart(12, '0')}`,
    member_type: 'context',
    attached_to_id: SPINE_ID,
    edge_type: 'informs',
    mint_via: 'position',
    provenance_class: 'declared',
    spine_source: spineSource,
    created_at: new Date(Date.UTC(2026, 0, 1 + n)),
    has_legacy_children: false,
  };
}

describe('C4 — readBranchMembers does not count a DECLARED membership as approximate', () => {
  test('one recorded + one assigned member, nothing in bands 2b/3 → approximateMembers 0', async () => {
    const membership = await readBranchMembers(
      { projectId: '99999999-0000-0000-0000-000000000000', spineId: SPINE_ID },
      stubPool([stubRow(1, MEMBERSHIP_SOURCE.recorded), stubRow(2, FUTURE_DECLARED_SOURCE)], 0)
    );
    expect(membership.members.map((m) => m.spineSource)).toEqual([
      MEMBERSHIP_SOURCE.recorded,
      FUTURE_DECLARED_SOURCE,
    ]);
    expect(membership.approximateMembers).toBe(0);
    expect(membership.possiblyIncomplete).toBe(false);
    expect(membership.tagOnlyNoPosition).toBe(0);
  });

  test('CONTROL — the same read still counts a legacy-approx member as approximate', async () => {
    const membership = await readBranchMembers(
      { projectId: '99999999-0000-0000-0000-000000000000', spineId: SPINE_ID },
      stubPool([stubRow(1, MEMBERSHIP_SOURCE.recorded), stubRow(2, MEMBERSHIP_SOURCE.legacyApprox)], 0)
    );
    expect(membership.approximateMembers).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * PART C — branch_history's own two sites (branch.routes.ts :456 marker, :556 exact)
 * ════════════════════════════════════════════════════════════════════════════════════ */

let projectId: string;
let spineId: string;
const CONN = `c4-conn-${STAMP}`;

async function viaTool(toolName: string, rawArgs: any): Promise<any> {
  return routeExecutor(toolName, validateToolArguments(toolName, rawArgs), { connectionId: CONN });
}
const responseText = (resp: any): string => resp?.content?.map((c: any) => c.text).join('\n') ?? '';

function fabMembership(sources: MembershipSource[]): BranchMembership {
  return {
    members: sources.map((s, i) => ({
      id: `55555555-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
      type: 'context' as const,
      attachedToId: spineId,
      edgeType: 'informs',
      mintVia: 'position',
      provenanceClass: 'declared',
      spineSource: s,
      hasLegacyChildren: false,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    })),
    // What PART B proves readBranchMembers returns for this population. Fabricated here
    // because the route consumes it as a number and cannot re-derive it.
    approximateMembers: sources.filter((s) => APPROXIMATE_SOURCES.has(s)).length,
    possiblyIncomplete: false,
    tagOnlyNoPosition: 0,
    // BAND 3 is empty for this population, so its id sample is empty and complete (P3
    // added both fields). Kept in step with the count deliberately: an empty band
    // with a "truncated" flag set would be a self-contradicting fixture.
    tagOnlyNoPositionIds: [],
    tagOnlyIdsTruncated: false,
  };
}

describe('C4 — branch_history reports a DECLARED membership as exact and unmarked', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'C4 fixture') RETURNING id`,
        [`c4-approx-${STAMP}`]
      )
    ).rows[0].id;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN });
    const spine = await viaTool('task_create', { title: 'C4 spine', type: 'feature', priority: 'low' });
    spineId = spine.structuredContent.task.id;
    await viaTool('branch_close', {});
  });

  afterAll(async () => {
    try {
      if (projectId) {
        for (const t of ['links', 'branch_positions', 'contexts', 'technical_decisions', 'tasks', 'sessions']) {
          await db.query(`DELETE FROM ${t} WHERE project_id = $1`, [projectId]);
        }
        await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      }
    } catch { /* teardown noise */ }
    await db.end();
  });

  test('one recorded + one assigned member → exact true, no [branch inferred] marker', async () => {
    vi.mocked(readBranchMembers).mockResolvedValueOnce(
      fabMembership([MEMBERSHIP_SOURCE.recorded, FUTURE_DECLARED_SOURCE])
    );
    const h = await viaTool('branch_history', { id: spineId });
    expect(h.structuredContent.totalMembers, 'both members must be listed').toBe(2);
    expect(h.structuredContent.approximateMembers).toBe(0);
    expect(h.structuredContent.exact).toBe(true);
    expect(responseText(h)).not.toContain('[branch inferred: pre-086 write]');
    expect(responseText(h)).not.toContain('branch is INFERRED, not recorded');
  });

  test('CONTROL — a legacy-approx member is still marked and still makes the answer inexact', async () => {
    vi.mocked(readBranchMembers).mockResolvedValueOnce(
      fabMembership([MEMBERSHIP_SOURCE.recorded, MEMBERSHIP_SOURCE.legacyApprox])
    );
    const h = await viaTool('branch_history', { id: spineId });
    expect(h.structuredContent.approximateMembers).toBe(1);
    expect(h.structuredContent.exact).toBe(false);
    expect(responseText(h)).toContain('[branch inferred: pre-086 write]');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
 * The classification itself
 * ════════════════════════════════════════════════════════════════════════════════════ */

describe('MEMBERSHIP_SOURCE_TRUST classifies every declared source', () => {
  test('every value in MEMBERSHIP_SOURCE_VALUES has a trust classification', () => {
    // The Record is exhaustive at COMPILE time, which is the real guard; this asserts the
    // runtime object was actually populated for each of them, and that the two published
    // views of the split agree. It goes RED for a value declared but left unclassified.
    for (const v of MEMBERSHIP_SOURCE_VALUES) {
      expect(MEMBERSHIP_SOURCE_TRUST[v], `no trust classification for source '${v}'`).toBeDefined();
      expect(APPROXIMATE_SOURCES.has(v)).toBe(MEMBERSHIP_SOURCE_TRUST[v] === 'approximate');
    }
    expect(APPROXIMATE_SOURCES.has(MEMBERSHIP_SOURCE.recorded)).toBe(false);
    expect(APPROXIMATE_SOURCES.has(MEMBERSHIP_SOURCE.legacyApprox)).toBe(true);
  });
});
