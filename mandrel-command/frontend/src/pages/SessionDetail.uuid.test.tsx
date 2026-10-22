/**
 * SessionDetail route guard (match ProjectDetail self-heal) — post-rebuild.
 *
 * THE BUG CLASS: the route `:id` was once guarded by presence only (`enabled: !!id`),
 * so a malformed id (e.g. /sessions/not-a-uuid) fired requests guaranteed to 400/404
 * and could wedge the page. ProjectDetail guards with a real-UUID predicate + an
 * error->redirect self-heal; the rebuilt SessionDetail matches: the page computes
 * `const valid = isValidUuid(id)`, passes it as the `enabled` flag to BOTH data hooks
 * (so no request fires on a bad id), and redirects to /sessions when the id is present
 * but not a UUID.
 *
 * This suite pins (1) the PURE guard decision (the predicate the component applies) and
 * (2) the exact wiring in the rebuilt page + its data hooks — cheap, deterministic,
 * drift-proof source invariants. Behavioural render coverage is in SessionDetail.test.tsx.
 */
import { describe, test, expect } from 'vitest';
import { isValidUuid } from '../utils/uuid';
import * as fs from 'fs';
import * as path from 'path';

const VALID_ID = 'c875b2af-9020-41b7-9595-d70221603464';

// The guard the component applies, in one place, mirroring SessionDetail:
//   const valid = isValidUuid(id)  →  enabled: valid  +  if (id && !valid) navigate('/sessions')
function queryEnabled(id: string | undefined): boolean {
  return isValidUuid(id);
}
function shouldRedirect(id: string | undefined): boolean {
  return !!id && !isValidUuid(id);
}

describe('SessionDetail route-guard decision', () => {
  test('malformed :id => query DISABLED and redirect TRUE (self-heal, no wedge)', () => {
    for (const bad of ['session_voiceitt-bridge', 'not-a-uuid', 'undefined']) {
      expect(queryEnabled(bad)).toBe(false); // no request fired
      expect(shouldRedirect(bad)).toBe(true); // redirected to /sessions
    }
  });

  test('VALID :id => query ENABLED and redirect FALSE (no over-rejection)', () => {
    expect(queryEnabled(VALID_ID)).toBe(true);
    expect(shouldRedirect(VALID_ID)).toBe(false);
  });

  test('absent :id => query disabled, no redirect (nothing to load yet)', () => {
    expect(queryEnabled(undefined)).toBe(false);
    expect(shouldRedirect(undefined)).toBe(false);
  });
});

describe('SessionDetail source matches the ProjectDetail template', () => {
  const page = fs.readFileSync(path.join(__dirname, 'SessionDetail.tsx'), 'utf8');
  const hooks = fs.readFileSync(path.join(__dirname, 'sessionDetail', 'hooks.ts'), 'utf8');

  test('the page gates both reads on a real-UUID flag, not bare presence', () => {
    // No remaining `enabled: !!id` (the old presence-only guard) anywhere.
    expect(page.includes('enabled: !!id')).toBe(false);
    expect(hooks.includes('enabled: !!id')).toBe(false);
    // The page derives the guard once and feeds it to both hooks.
    expect(page).toMatch(/const valid = isValidUuid\(id\)/);
    expect(page).toMatch(/useSessionDetail\(id,\s*valid\)/);
    expect(page).toMatch(/useSessionFiles\(id,\s*valid\)/);
    // The hooks only fire when both an id is present AND the enabled flag is set.
    const matches = hooks.match(/enabled:\s*Boolean\(id\)\s*&&\s*enabled/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('a malformed :id triggers an explicit navigate redirect', () => {
    expect(page).toMatch(/id && !valid/);
    expect(page).toMatch(/navigate\(['"]\/sessions['"]\)/);
  });
});
