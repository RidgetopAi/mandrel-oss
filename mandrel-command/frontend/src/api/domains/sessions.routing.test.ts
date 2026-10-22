/**
 * sessions domain — the backend-split-is-hidden proof (the core P0.5 promise).
 *
 * "sessions" is served by TWO backends: the Command backend owns the ANALYTICS
 * reads (`/api/sessions/*`) and mcp-server owns the LIFECYCLE (`/api/v2/sessions/*`,
 * proxied). `/api/v2` is an ownership boundary, NOT a version. This test proves the
 * caller cannot tell: two sibling methods on the SAME domain object route to the
 * two different path families, through the SAME shared `http` transport.
 *
 * We spy on `http` (the single transport) and assert the exact path each method
 * hands it — so a future backend dedup that changes these paths is caught here,
 * and no screen has to change.
 */
import { sessionsApi } from './sessions';
import { http } from '../request';
import { getBrowserTimeZone } from '../../utils/browserTimeZone';

// trends() auto-attaches the viewer's tz so day-buckets align with the
// local calendar. Mirror that here so the param assertions stay robust across runners.
const tzParam = getBrowserTimeZone() ? { tz: getBrowserTimeZone() } : {};

const okEnvelope = (data: unknown) => ({ success: true, data });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sessions: one domain, two backends, caller cannot tell', () => {
  test('list() → Command backend path /sessions (relative to the /api base)', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope({ sessions: [] }) as never);
    await sessionsApi.list();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('/sessions');
  });

  test('current() → Command backend path /sessions/current', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope({ session: null }) as never);
    await sessionsApi.current();
    expect(spy.mock.calls[0][0]).toBe('/sessions/current');
  });

  test('start() → mcp-server path /v2/sessions/start (the SAME caller-visible API)', async () => {
    const spy = vi.spyOn(http, 'post').mockResolvedValue(okEnvelope({ id: 's1' }) as never);
    await sessionsApi.start({ title: 't' });
    expect(spy.mock.calls[0][0]).toBe('/v2/sessions/start');
  });

  test('end() → mcp-server path /v2/sessions/:id/end', async () => {
    const spy = vi.spyOn(http, 'post').mockResolvedValue(okEnvelope({ id: 's1' }) as never);
    await sessionsApi.end('s1');
    expect(spy.mock.calls[0][0]).toBe('/v2/sessions/s1/end');
  });

  test('active() → mcp-server path /v2/sessions/active', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope(null) as never);
    await sessionsApi.active();
    expect(spy.mock.calls[0][0]).toBe('/v2/sessions/active');
  });

  test('files() → mcp-server path /v2/sessions/:id/files', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope({ files: [] }) as never);
    await sessionsApi.files('s1');
    expect(spy.mock.calls[0][0]).toBe('/v2/sessions/s1/files');
  });

  // ---- actor slice (the "who" dimension) forwarding ----------

  test('list() forwards the optional actor slice as a query param', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope({ sessions: [] }) as never);
    await sessionsApi.list({ actor: 'coordinator', limit: 10 });
    expect(spy.mock.calls[0][0]).toBe('/sessions');
    expect(spy.mock.calls[0][1]).toEqual({ params: { actor: 'coordinator', limit: 10 } });
  });

  test('trends() forwards actor (+ days/project_id) when provided', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope([]) as never);
    await sessionsApi.trends({ days: 7, projectId: 'p1', actor: 'tick' });
    expect(spy.mock.calls[0][0]).toBe('/sessions/trends');
    expect(spy.mock.calls[0][1]).toEqual({
      params: { days: 7, project_id: 'p1', actor: 'tick', ...tzParam },
    });
  });

  test('trends() omits actor when not provided (additive, non-breaking)', async () => {
    const spy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope([]) as never);
    await sessionsApi.trends({ days: 7 });
    expect(spy.mock.calls[0][1]).toEqual({ params: { days: 7, ...tzParam } });
  });

  test('BOTH families ride the SAME base (relative /api) — every path starts with a single slash, none is absolute', () => {
    // A guard against anyone re-hardcoding an absolute host (e.g. localhost:8080) // reserved-port-ok: comment naming the banned host, binds nothing
    // for the v2 lifecycle calls, which is exactly the split this client removes.
    const getSpy = vi.spyOn(http, 'get').mockResolvedValue(okEnvelope({ sessions: [] }) as never);
    const postSpy = vi.spyOn(http, 'post').mockResolvedValue(okEnvelope({ id: 's1' }) as never);
    return Promise.all([sessionsApi.list(), sessionsApi.start()]).then(() => {
      const paths = [...getSpy.mock.calls, ...postSpy.mock.calls].map((c) => c[0] as string);
      for (const p of paths) {
        expect(p.startsWith('/')).toBe(true);
        expect(p.startsWith('//')).toBe(false);
        expect(/^https?:/i.test(p)).toBe(false);
      }
    });
  });
});
