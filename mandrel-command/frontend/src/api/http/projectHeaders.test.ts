/**
 * projectHeaders — the AMBIENT fallback ladder (epic 41293984 §A2).
 *
 * The axios interceptor (services/api.ts) and the generated-client header resolver
 * (api/client.ts) BOTH delegate here, so this one suite guards the rule for both.
 *
 * ── THE PROPERTY UNDER TEST ──────────────────────────────────────────────────────────
 * Not "does it return the stored id". The property is:
 *
 *     THE RESOLVER RETURNS undefined ONLY WHEN THERE IS GENUINELY NOTHING TO RETURN.
 *
 * `undefined` is not a neutral value here: several backend controllers read a missing
 * X-Project-ID as "every project", so returning it does not fail — it silently widens
 * the app to the whole instance. Every case below is therefore a route to `undefined`
 * that must NOT be taken while any rung holds a real project.
 *
 * ── THE POPULATION THE LADDER ENUMERATES ─────────────────────────────────────────────
 * Each rung, alone; each rung with every rung above it broken; and the genuinely-empty
 * case. The corrupt/empty/absent members are the point — those are the values that
 * slipped through the single-rung version.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  resolveProjectHeader,
  rememberAmbientProject,
  __resetRememberedAmbientProject,
} from './projectHeaders';

const VALID_ID = 'c875b2af-9020-41b7-9595-d70221603464';
const OTHER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const THIRD_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

const setPrimary = (id: string) =>
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id, name: 'x' }));
const setLegacy = (id: string) =>
  localStorage.setItem('aidis_current_project', JSON.stringify({ id }));
const setSettingsCache = (id: string) =>
  localStorage.setItem('aidis_user_settings', JSON.stringify({ defaultProjectId: id }));

beforeEach(() => {
  localStorage.clear();
  __resetRememberedAmbientProject();
});

describe('resolveProjectHeader — rung 1 (the ambient project key)', () => {
  test('returns a VALID stored UUID', () => {
    setPrimary(VALID_ID);
    expect(resolveProjectHeader()).toBe(VALID_ID);
  });

  test('rung 1 WINS over every rung below it', () => {
    setPrimary(VALID_ID);
    setLegacy(OTHER_ID);
    setSettingsCache(THIRD_ID);
    rememberAmbientProject(THIRD_ID);
    expect(resolveProjectHeader()).toBe(VALID_ID);
  });
});

describe('resolveProjectHeader — the corrupt-value self-heal no longer goes unscoped', () => {
  test('a corrupt id is PURGED but falls through to the legacy mirror (contoso repro)', () => {
    localStorage.setItem(
      'aidis_selected_project',
      JSON.stringify({ id: 'session_voiceitt-bridge', name: 'voiceitt-bridge' }),
    );
    setLegacy(OTHER_ID);

    // The old behaviour was `undefined` here — a self-heal that left the app unscoped.
    expect(resolveProjectHeader()).toBe(OTHER_ID);
    // …and it RE-SEATS rung 1, so the heal is durable rather than repeated on every request.
    expect(JSON.parse(localStorage.getItem('aidis_selected_project')!).id).toBe(OTHER_ID);
  });

  test('a corrupt id with no legacy mirror falls through to the settings cache', () => {
    localStorage.setItem('aidis_selected_project', JSON.stringify({ id: 'not-a-uuid' }));
    setSettingsCache(THIRD_ID);
    expect(resolveProjectHeader()).toBe(THIRD_ID);
  });

  test('unparseable JSON is treated as corrupt and still resolves from a lower rung', () => {
    localStorage.setItem('aidis_selected_project', '{not-json');
    setSettingsCache(THIRD_ID);
    expect(resolveProjectHeader()).toBe(THIRD_ID);
  });

  test('the UNASSIGNED sentinel is never attached, and falls through', () => {
    setPrimary('00000000-0000-0000-0000-000000000000');
    setSettingsCache(THIRD_ID);
    expect(resolveProjectHeader()).toBe(THIRD_ID);
  });
});

describe('resolveProjectHeader — rung 3 (the settings cache)', () => {
  test('resolves when BOTH project keys are absent (the deleted-project path)', () => {
    setSettingsCache(VALID_ID);
    expect(resolveProjectHeader()).toBe(VALID_ID);
  });

  test('a settings cache holding a NON-uuid is ignored, not sent', () => {
    localStorage.setItem('aidis_user_settings', JSON.stringify({ defaultProjectId: 'Alpha' }));
    // The pre-41293984 cache stored a project NAME here. It must never be sent as an id.
    expect(resolveProjectHeader()).toBeUndefined();
  });
});

describe('resolveProjectHeader — rung 4 (the in-memory mirror)', () => {
  test('survives a FULL localStorage wipe and heals the keys', () => {
    rememberAmbientProject(VALID_ID);
    localStorage.clear();

    // The §A2 mutation: storage is gone and React cannot see it. The next request must
    // still name a project.
    expect(resolveProjectHeader()).toBe(VALID_ID);
    expect(JSON.parse(localStorage.getItem('aidis_selected_project')!).id).toBe(VALID_ID);
    expect(JSON.parse(localStorage.getItem('aidis_current_project')!).id).toBe(VALID_ID);
  });

  test('refuses to remember a non-UUID (a bad value must not become a rung)', () => {
    rememberAmbientProject('all');
    rememberAmbientProject('');
    rememberAmbientProject(undefined);
    expect(resolveProjectHeader()).toBeUndefined();
  });
});

describe('resolveProjectHeader — the genuinely empty case', () => {
  test('every rung empty → undefined (a user with no projects at all)', () => {
    expect(resolveProjectHeader()).toBeUndefined();
  });

  test('does not throw on any malformed combination', () => {
    localStorage.setItem('aidis_selected_project', '{');
    localStorage.setItem('aidis_current_project', 'null');
    localStorage.setItem('aidis_user_settings', '[]');
    expect(() => resolveProjectHeader()).not.toThrow();
  });
});
