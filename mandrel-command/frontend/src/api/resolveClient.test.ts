/**
 * Unit tests for resolveNavRecord — the frontend side of the /r landing. Mocks the
 * shared apiClient and asserts each of the endpoint's outcomes maps to the correct
 * fail-closed union member (unique / ambiguous / invalid / not-found) and that the
 * client NEVER throws (every path returns a renderable state).
 */

import apiClient from '../services/api';
import { resolveNavRecord } from './resolveClient';

// jest.mock is hoisted above the imports by babel-jest, so the mock is registered
// before '../services/api' loads (avoids pulling in axios + its module side effects).
vi.mock('../services/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

const mockGet = (apiClient as unknown as { get: jest.Mock }).get;

beforeEach(() => {
  mockGet.mockReset();
});

describe('resolveNavRecord', () => {
  it('calls GET /resolve/<id> with the encoded id, as an EXPLICITLY GLOBAL read', async () => {
    mockGet.mockResolvedValue({ success: true, type: 'task', id: 'u', title: 't', url: '/tasks/u' });
    await resolveNavRecord('b822dfcb');
    // The `project_id=all` sentinel is load-bearing, not incidental (Reviewer B4, §A4):
    // the backend resolves a short id inside a project scope, so with the ambient header
    // pinned to the user's default a link to a record in ANY other project 404s — and the
    // global switcher that could have unwedged the user is gone. Asserted on the exact
    // config so a silent drop of the sentinel is a RED here as well as in
    // api/http/globalRead.seam.test.ts, which measures it at the axios adapter.
    expect(mockGet).toHaveBeenCalledWith('/resolve/b822dfcb', {
      params: { project_id: 'all' },
    });
  });

  it('200 → { status: "unique", record }', async () => {
    mockGet.mockResolvedValue({
      success: true,
      type: 'decision',
      id: 'dec-uuid',
      title: 'A decision',
      url: '/decisions/dec-uuid',
    });
    const result = await resolveNavRecord('dec-uuid');
    expect(result).toEqual({
      status: 'unique',
      record: { type: 'decision', id: 'dec-uuid', title: 'A decision', url: '/decisions/dec-uuid' },
    });
  });

  it('409 → { status: "ambiguous", candidates } (never a silent pick)', async () => {
    const candidates = [
      { type: 'task', id: 't1', title: 'Task one', url: '/tasks/t1' },
      { type: 'decision', id: 'd1', title: 'Dec one', url: '/decisions/d1' },
    ];
    mockGet.mockRejectedValue({ message: 'Ambiguous id', details: { ambiguous: true, candidates } });
    const result = await resolveNavRecord('aaaaaaaa');
    expect(result).toEqual({ status: 'ambiguous', candidates });
  });

  it('400 → { status: "invalid" }', async () => {
    mockGet.mockRejectedValue({ message: 'Invalid id', details: { error: 'Invalid id' } });
    expect(await resolveNavRecord('zzzz')).toEqual({ status: 'invalid' });
  });

  it('404 → { status: "notfound" }', async () => {
    mockGet.mockRejectedValue({ message: 'Not found', details: { error: 'Not found' } });
    expect(await resolveNavRecord('deadbeef00000000')).toEqual({ status: 'notfound' });
  });

  // --- the backend's EXPLANATION must survive the mapping ----------
  // The client is the only thing between the backend's sentence and the screen; if it
  // drops `message` the page silently falls back to generic copy and the whole
  // "tell the user what happened" contract is lost with no test failing.

  it('carries the backend NOT-FOUND explanation through to the caller', async () => {
    const message =
      'No record matches id "deadbeef". Searched every context, task, decision, session, ' +
      'or project in any project. Nothing has an id starting with this.';
    mockGet.mockRejectedValue({ message: 'Not found', details: { error: 'Not found', message } });
    expect(await resolveNavRecord('deadbeef')).toEqual({ status: 'notfound', message });
  });

  it('carries the backend INVALID explanation (which shape rule was broken)', async () => {
    const message = '"bbbb" is not a full UUID or a valid short id. A short id must be at least 8 hex characters';
    mockGet.mockRejectedValue({
      message: 'Invalid id',
      details: { error: 'Invalid id', message, reason: 'too-short' },
    });
    expect(await resolveNavRecord('bbbb')).toEqual({ status: 'invalid', message });
  });

  it('maps the NEW record types (session/project) like any other unique match', async () => {
    mockGet.mockResolvedValue({
      success: true,
      type: 'session',
      id: 'sid',
      title: 'A session',
      url: '/sessions/sid',
    });
    expect(await resolveNavRecord('sid')).toEqual({
      status: 'unique',
      record: { type: 'session', id: 'sid', title: 'A session', url: '/sessions/sid' },
    });

    mockGet.mockResolvedValue({
      success: true,
      type: 'project',
      id: 'pid',
      title: 'A project',
      url: '/projects/pid',
    });
    expect(await resolveNavRecord('pid')).toEqual({
      status: 'unique',
      record: { type: 'project', id: 'pid', title: 'A project', url: '/projects/pid' },
    });
  });

  it('an unexpected error (no details) → { status: "notfound" } (fail-closed, no throw)', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    await expect(resolveNavRecord('b822dfcb')).resolves.toEqual({ status: 'notfound' });
  });
});
