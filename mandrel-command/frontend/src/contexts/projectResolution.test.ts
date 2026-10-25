import {
  parseAidisProjectName,
  resolveRealProject,
  selectFallbackProject,
} from './projectResolution';
import { isValidUuid } from '../utils/uuid';
import type { Project } from '../types/project';
import type { Session } from '../types/session';

/**
 * Guard test for an earlier task — the "aidis-**pi-rivet**" default-project bug.
 *
 * Root cause: MCP `project_current` returns the name in markdown bold
 * (`Current Project: **pi-rivet**`). The old UI captured `**pi-rivet**`
 * verbatim, failed to match the real project list, and fell into a synthetic
 * branch that built id `aidis-**pi-rivet**` and early-returned. The AntD
 * <Select> echoed that unmatched value literally AND the non-UUID id 400'd every
 * UUID-validated backend route ("Failed to load contexts").
 *
 * These tests assert the two halves of the fix:
 *   1. STRIP THE MARKDOWN — `**pi-rivet**` resolves to the REAL pi-rivet UUID.
 *   2. THE SAFEGUARD — an unresolvable name falls back to a REAL-UUID project,
 *      never a synthetic `aidis-<name>` id.
 * And the INVARIANT: every project these helpers return has a real UUID.
 */

const PI_RIVET_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWEST_UUID = '99999999-8888-4777-8666-555544443333';
const UNASSIGNED_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

const piRivet: Project = {
  id: PI_RIVET_UUID,
  name: 'pi-rivet',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-06-01T00:00:00.000Z',
};

const otherProject: Project = {
  id: OTHER_UUID,
  name: 'some-other-project',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-05-01T00:00:00.000Z',
};

const newestProject: Project = {
  id: NEWEST_UUID,
  name: 'most-recently-touched',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-06-18T00:00:00.000Z', // newest by last_activity
};

const unassigned: Project = {
  id: UNASSIGNED_PROJECT_ID,
  name: 'unassigned',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const allProjects: Project[] = [unassigned, otherProject, piRivet, newestProject];

// The exact text the MCP project_current route emits (mcp-server project.routes.ts).
const PROJECT_CURRENT_TEXT =
  '🟢 Current Project: **pi-rivet**\n\n' +
  '📄 Description: the pi\n' +
  '📊 Status: active\n' +
  '📈 Contexts: 12\n' +
  '⏰ Last Updated: 2026-06-18\n\n' +
  '🔄 Switch projects with: project_switch <name-or-id>';

const AUTO_SELECTED_TEXT =
  '🟢 Current Project: **pi-rivet** (auto-selected)\n\n' +
  '📄 Description: the pi\n📊 Status: active';

describe('parseAidisProjectName — strips markdown bold from project_current', () => {
  test('captures the REAL name without the ** markers', () => {
    expect(parseAidisProjectName(PROJECT_CURRENT_TEXT)).toBe('pi-rivet');
  });

  test('strips the (auto-selected) annotation too', () => {
    expect(parseAidisProjectName(AUTO_SELECTED_TEXT)).toBe('pi-rivet');
  });

  test('returns null for None / unassigned / empty', () => {
    expect(parseAidisProjectName('Current Project: None')).toBeNull();
    expect(parseAidisProjectName('Current Project: unassigned')).toBeNull();
    expect(parseAidisProjectName('no project here')).toBeNull();
    expect(parseAidisProjectName('')).toBeNull();
    expect(parseAidisProjectName(null)).toBeNull();
  });

  test('REGRESSION: the OLD raw capture (no strip) would NOT have matched', () => {
    // Demonstrates the bug: the literal regex capture before sanitizing.
    const rawCapture = PROJECT_CURRENT_TEXT.match(/Current project:\s*([^\n]+)/i)![1].trim();
    expect(rawCapture).toBe('**pi-rivet**'); // <- what the old code resolved against
    // ...which finds nothing in the real list (this is what triggered synthetic).
    expect(allProjects.find((p) => p.name === rawCapture)).toBeUndefined();
    // The new sanitized name DOES resolve.
    expect(allProjects.find((p) => p.name === parseAidisProjectName(PROJECT_CURRENT_TEXT))).toBe(
      piRivet
    );
  });
});

describe('resolveRealProject — (a) resolves a sanitized name to the REAL UUID', () => {
  test('given **pi-rivet** text, currentProject resolves to the REAL project UUID', () => {
    const name = parseAidisProjectName(PROJECT_CURRENT_TEXT);
    const resolved = resolveRealProject(name, allProjects);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(PI_RIVET_UUID);
    // The bug value must NEVER be produced.
    expect(resolved!.id).not.toBe('aidis-**pi-rivet**');
    expect(resolved!.id).not.toMatch(/^aidis-/);
    // INVARIANT: id is a real UUID.
    expect(isValidUuid(resolved!.id)).toBe(true);
  });

  test('never resolves to the UNASSIGNED sentinel', () => {
    expect(resolveRealProject('unassigned', allProjects)).toBeNull();
  });

  test('returns null for an unresolvable name (caller must fall back)', () => {
    expect(resolveRealProject('ghost-project', allProjects)).toBeNull();
    expect(resolveRealProject('**pi-rivet**', allProjects)).toBeNull(); // un-stripped never matches
  });
});

describe('selectFallbackProject — (b) unresolvable name falls back to a REAL-UUID project', () => {
  const noSessions: Session[] = [];

  test('returns a real-UUID project (never a synthetic id) when name is unresolvable', () => {
    const fallback = selectFallbackProject(allProjects, noSessions);
    expect(fallback).not.toBeNull();
    expect(isValidUuid(fallback!.id)).toBe(true); // INVARIANT
    expect(fallback!.id).not.toMatch(/^aidis-/);
    expect(fallback!.id).not.toBe(UNASSIGNED_PROJECT_ID);
  });

  test('priority (a) last-active: picks the most-recent valid session\'s project', () => {
    const sessions: Session[] = [
      {
        id: 's-old',
        project_id: NEWEST_UUID,
        project_name: 'most-recently-touched',
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-01T00:00:00.000Z',
        last_activity_at: '2026-02-01T00:00:00.000Z',
      } as Session,
      {
        id: 's-new',
        project_id: OTHER_UUID,
        project_name: 'some-other-project',
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-10T00:00:00.000Z',
        last_activity_at: '2026-06-15T00:00:00.000Z', // most recent session
      } as Session,
    ];
    const fallback = selectFallbackProject(allProjects, sessions);
    expect(fallback!.id).toBe(OTHER_UUID); // from the most-recent session
    expect(isValidUuid(fallback!.id)).toBe(true);
  });

  test('priority (b) most-recently-updated: sorts by last_activity when no sessions', () => {
    const fallback = selectFallbackProject(allProjects, noSessions);
    // newestProject has the latest last_activity (2026-06-18).
    expect(fallback!.id).toBe(NEWEST_UUID);
  });

  test('a session pointing at a synthetic/unassigned id is ignored (invariant holds)', () => {
    const badSessions: Session[] = [
      {
        id: 's-bad',
        project_id: 'aidis-pi-rivet', // synthetic, not a UUID
        project_name: 'pi-rivet',
        created_at: '2026-06-19T00:00:00.000Z',
        updated_at: '2026-06-19T00:00:00.000Z',
        last_activity_at: '2026-06-19T00:00:00.000Z',
      } as Session,
      {
        id: 's-unassigned',
        project_id: UNASSIGNED_PROJECT_ID,
        project_name: 'unassigned',
        created_at: '2026-06-19T00:00:00.000Z',
        updated_at: '2026-06-19T00:00:00.000Z',
        last_activity_at: '2026-06-19T00:00:00.000Z',
      } as Session,
    ];
    const fallback = selectFallbackProject(allProjects, badSessions);
    // Falls through to last_activity sort -> newestProject; never the synthetic id.
    expect(fallback!.id).toBe(NEWEST_UUID);
    expect(isValidUuid(fallback!.id)).toBe(true);
  });

  test('user preference (defaultProjectId) wins when it resolves to a real project', () => {
    const fallback = selectFallbackProject(allProjects, noSessions, PI_RIVET_UUID);
    expect(fallback!.id).toBe(PI_RIVET_UUID);
  });

  test('the preference is matched BY ID, so a RENAME cannot detach it (page-scope epic §A)', () => {
    // Same project, new name. Under the old name-keyed preference this returned the
    // durable fallback instead — the user was silently bounced to another project with
    // no error and no way to tell why.
    const renamed = allProjects.map((p) =>
      p.id === PI_RIVET_UUID ? { ...p, name: 'pi-rivet-renamed' } : p,
    );
    expect(selectFallbackProject(renamed, noSessions, PI_RIVET_UUID)!.id).toBe(PI_RIVET_UUID);
  });

  test('a preference holding a NAME (the pre-41293984 cache) resolves nothing and falls through', () => {
    // Defence against a stale cached value of the old shape reaching this function.
    const fallback = selectFallbackProject(allProjects, noSessions, 'pi-rivet');
    expect(fallback!.id).not.toBe(PI_RIVET_UUID);
    expect(isValidUuid(fallback!.id)).toBe(true);
  });

  test('returns null when no real-UUID project exists (only unassigned)', () => {
    expect(selectFallbackProject([unassigned], noSessions)).toBeNull();
  });
});

describe('END-TO-END invariant: currentProject.id is ALWAYS a real UUID', () => {
  const noSessions: Session[] = [];

  test('(a) resolvable **pi-rivet** -> real UUID, NOT aidis-**pi-rivet**', () => {
    const name = parseAidisProjectName(PROJECT_CURRENT_TEXT);
    const resolved = resolveRealProject(name, allProjects);
    const chosen = resolved ?? selectFallbackProject(allProjects, noSessions);
    expect(chosen!.id).toBe(PI_RIVET_UUID);
    expect(isValidUuid(chosen!.id)).toBe(true);
  });

  test('(b) unresolvable name -> fallback real UUID, never synthetic', () => {
    const name = parseAidisProjectName('🟢 Current Project: **ghost-that-does-not-exist**\n');
    const resolved = resolveRealProject(name, allProjects);
    const chosen = resolved ?? selectFallbackProject(allProjects, noSessions);
    expect(chosen).not.toBeNull();
    expect(isValidUuid(chosen!.id)).toBe(true);
    expect(chosen!.id).not.toMatch(/^aidis-/);
  });
});

/**
 * THE ZERO POPULATION (Reviewer B4, item 3). `allProjects` is no longer guaranteed
 * non-empty: `GET /api/projects` is project-scoped, so a mis-scoped or zero-grant read
 * yields an EMPTY or ONE-ELEMENT list. This pins what the fallback ladder does at each
 * end of that range, because "resolves to undefined and the app goes silently unscoped"
 * is precisely the §A2 failure the rung ladder exists to make unreachable.
 *
 * The two ends are asserted separately on purpose: a one-element list must NOT be treated
 * as a failure (it is the correct answer for a user with one project), and an empty list
 * must NOT be treated as a success.
 */
describe('selectFallbackProject — the zero and one populations (§A2 / Reviewer B4)', () => {
  const noSessions: Session[] = [];
  const one: Project = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Only project',
    status: 'active',
    last_activity: '2026-06-01T00:00:00.000Z',
  } as Project;

  test('EMPTY list + NO default -> null, never a fabricated or undefined id', () => {
    // null is the honest answer and it is what makes the failure LOUD downstream:
    // ProjectContext leaves currentProject null, resolveProjectHeader() exhausts every
    // rung and logs an error, and scopedRequestConfig THROWS for any page that tries to
    // send a request. Nothing quietly goes unscoped.
    expect(selectFallbackProject([], noSessions, undefined)).toBeNull();
  });

  test('EMPTY list + a default id that no longer resolves -> still null, not the stale id', () => {
    // The §A2 shape: the user's default was deleted or access revoked. Echoing the stored
    // id back would send a project the backend now 403s under F-04, on every request.
    expect(
      selectFallbackProject([], noSessions, '99999999-9999-4999-8999-999999999999')
    ).toBeNull();
  });

  test('ONE-element list + no default -> that project (one option is not a failure)', () => {
    expect(selectFallbackProject([one], noSessions, undefined)?.id).toBe(one.id);
  });

  test('ONE-element list + an unresolvable default -> that project, not null', () => {
    // The preference must degrade to the durable fallback rather than to "no project".
    expect(
      selectFallbackProject([one], noSessions, '99999999-9999-4999-8999-999999999999')?.id
    ).toBe(one.id);
  });
});
