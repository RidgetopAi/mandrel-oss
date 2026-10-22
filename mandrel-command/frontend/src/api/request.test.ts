/**
 * Unified request layer — envelope unwrap + verb delegation.
 *
 * Proves:
 *   - unwrapData() returns the typed payload for a `{ success:true, data }`
 *     envelope, THROWS the server message on `success:false`, and passes a raw
 *     (non-enveloped) body straight through.
 *   - the typed `http` verbs delegate to the ONE shared axios instance
 *     (services/api `apiClient`) — i.e. there is a single place that hits the
 *     network — WITHOUT making a real request.
 */
import { http, unwrapData } from './request';
import { apiClient } from '../services/api';

describe('unwrapData (envelope → payload)', () => {
  test('returns data for a success envelope', () => {
    expect(unwrapData({ success: true, data: { n: 1 } }, 'fail')).toEqual({ n: 1 });
  });

  test('throws the server error message on success:false', () => {
    expect(() =>
      unwrapData({ success: false, error: { message: 'boom' } }, 'fallback')
    ).toThrow('boom');
  });

  test('throws the fallback message when success:false carries no message', () => {
    expect(() => unwrapData({ success: false }, 'fallback')).toThrow('fallback');
  });

  test('passes a raw (non-envelope) body straight through', () => {
    const raw = [{ id: 'a' }, { id: 'b' }];
    expect(unwrapData(raw, 'fail')).toBe(raw);
  });
});

describe('http verbs delegate to the shared axios instance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('http.get forwards url + config to apiClient.get (no real request)', async () => {
    const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({ ok: true } as never);
    const out = await http.get('/contexts', { params: { limit: 5 } });
    expect(spy).toHaveBeenCalledWith('/contexts', { params: { limit: 5 } });
    expect(out).toEqual({ ok: true });
  });

  test('http.post forwards url + body to apiClient.post', async () => {
    const spy = vi.spyOn(apiClient, 'post').mockResolvedValue({ id: 'x' } as never);
    await http.post('/contexts', { content: 'hi' });
    expect(spy).toHaveBeenCalledWith('/contexts', { content: 'hi' }, undefined);
  });

  test('http.del forwards to apiClient.delete', async () => {
    const spy = vi.spyOn(apiClient, 'delete').mockResolvedValue({ success: true } as never);
    await http.del('/contexts/abc');
    expect(spy).toHaveBeenCalledWith('/contexts/abc', undefined);
  });
});
