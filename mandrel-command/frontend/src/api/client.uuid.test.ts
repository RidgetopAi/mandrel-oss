/**
 * H1 — OpenAPI client X-Project-ID self-heal.
 *
 * THE BUG (sibling to the already-fixed services/api.ts):
 *   OpenAPI.HEADERS attached a stored project id as `X-Project-ID` checking only
 *   `!== UNASSIGNED`, never `isValidUuid`. A corrupt stored value (e.g.
 *   `session_voiceitt-bridge`) was sent as the header → the backend project
 *   middleware 400'd EVERY /api call → dashboard wedge.
 *
 * WHAT THIS PROVES:
 *   - A corrupt stored id is NEVER attached AND the stored keys are purged
 *     (self-heal, no manual site-data clearing).
 *   - The UNASSIGNED sentinel is never attached.
 *   - A VALID stored id IS attached (no over-rejection regression).
 *   - Unparseable JSON is treated as corrupt and purged.
 */
import { OpenAPI } from './client';

// crypto.randomUUID is used by the header resolver; jsdom may not provide it.
beforeAll(() => {
  if (!('crypto' in globalThis) || typeof (globalThis as any).crypto?.randomUUID !== 'function') {
    (globalThis as any).crypto = {
      ...(globalThis as any).crypto,
      randomUUID: () => '00000000-0000-0000-0000-000000000000',
    };
  }
});

const VALID_ID = 'c875b2af-9020-41b7-9595-d70221603464';

async function resolveHeaders(): Promise<Record<string, string>> {
  const h = OpenAPI.HEADERS;
  if (typeof h === 'function') {
    return (await (h as any)({} as any)) as Record<string, string>;
  }
  return {} as Record<string, string>;
}

beforeEach(() => {
  localStorage.clear();
});

describe('OpenAPI client X-Project-ID self-heal (H1)', () => {
  test('attaches X-Project-ID for a VALID stored id', async () => {
    localStorage.setItem('aidis_selected_project', JSON.stringify({ id: VALID_ID, name: 'x' }));
    const headers = await resolveHeaders();
    expect(headers['X-Project-ID']).toBe(VALID_ID);
  });

  test('does NOT attach and PURGES a corrupt stored id (contoso)', async () => {
    localStorage.setItem(
      'aidis_selected_project',
      JSON.stringify({ id: 'session_voiceitt-bridge', name: 'voiceitt-bridge' })
    );
    const headers = await resolveHeaders();
    expect(headers['X-Project-ID']).toBeUndefined();
    // self-heal: offending keys purged
    expect(localStorage.getItem('aidis_selected_project')).toBeNull();
    expect(localStorage.getItem('aidis_current_project')).toBeNull();
  });

  test('does NOT attach the UNASSIGNED sentinel', async () => {
    localStorage.setItem(
      'aidis_selected_project',
      JSON.stringify({ id: '00000000-0000-0000-0000-000000000000' })
    );
    const headers = await resolveHeaders();
    expect(headers['X-Project-ID']).toBeUndefined();
  });

  test('treats unparseable JSON as corrupt and purges it', async () => {
    localStorage.setItem('aidis_selected_project', '{not-json');
    const headers = await resolveHeaders();
    expect(headers['X-Project-ID']).toBeUndefined();
    expect(localStorage.getItem('aidis_selected_project')).toBeNull();
  });

  test('no stored project => no header, no throw', async () => {
    const headers = await resolveHeaders();
    expect(headers['X-Project-ID']).toBeUndefined();
  });
});
