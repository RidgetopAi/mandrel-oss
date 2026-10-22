/**
 * an earlier task — the client half of the project-delete gate.
 *
 * `DELETE /api/projects/:id` is now SERVER-gated: without `?confirm=true` the backend
 * answers 409 with the measured blast radius and destroys nothing. That gate is the real
 * one and it is tested on the server. What can still go wrong on this side is the URL:
 * the confirmation the user gave in the Danger Zone modal has to actually reach the wire,
 * and it must not be sent when nobody confirmed.
 *
 * This test drives the REAL `api.projects.remove` and reads the URL it hands the shared
 * transport — it does not re-implement the query-building. `http` is stubbed at the
 * transport seam only (the same seam the other domain tests use), because the thing being
 * measured is the request, not the response.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { http } from '../request';
import { projectsApi as projects } from './projects';

const okEnvelope = { success: true, data: {} };

describe('api.projects.remove — the confirmation reaches the wire', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends ?confirm=true when the caller confirmed', async () => {
    const del = vi.spyOn(http, 'del').mockResolvedValue(okEnvelope as never);

    await projects.remove('p-1', { confirm: true });

    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toBe('/projects/p-1?confirm=true');
  });

  it('sends NO confirm param when the caller did not confirm — the request stays a safe probe', async () => {
    const del = vi.spyOn(http, 'del').mockResolvedValue(okEnvelope as never);

    await projects.remove('p-1');
    await projects.remove('p-2', {});
    await projects.remove('p-3', { confirm: false });

    // A confirmation must be something the caller SAID, never a default. If any of these
    // grew a `confirm=true`, the server gate would be satisfied by a caller who never
    // confirmed — which is the client-side half of the defect this task fixed.
    for (const call of del.mock.calls) {
      expect(String(call[0])).not.toContain('confirm');
    }
    expect(del.mock.calls.map((c) => c[0])).toEqual(['/projects/p-1', '/projects/p-2', '/projects/p-3']);
  });

  it('still encodes the id (the confirm flag is appended, it does not replace the escaping)', async () => {
    const del = vi.spyOn(http, 'del').mockResolvedValue(okEnvelope as never);

    await projects.remove('a b/c', { confirm: true });

    expect(del.mock.calls[0][0]).toBe('/projects/a%20b%2Fc?confirm=true');
  });

  it('propagates the server refusal — a 409 is never swallowed into a silent success', async () => {
    // THIS DOUBLE USED TO LIE. It rejected with `new Error(...)` and its comment claimed
    // that rejection "IS how the blast-radius sentence reaches the user" — green, and
    // false. The real transport never produces an `Error` here: the shared axios
    // interceptor rejects with a PLAIN OBJECT (`{message, code, status, details}`), so
    // the component's `instanceof Error` check was always false and the user only ever
    // saw "Delete failed.". A stub that answers a contract the real surface never
    // produces is worse than no stub (tests-are-the-rock).
    //
    // It now rejects with the interceptor's ACTUAL shape. What the user ends up seeing is
    // not asserted here — it is proved end-to-end, against the real interceptor rather
    // than any double, in request.apiErrorMessage.test.ts. This file's job is narrower:
    // the rejection must PROPAGATE rather than resolve.
    const apiErrorShape = {
      message: '⚠️  Refusing to delete project "victim" without confirmation.',
      status: 409,
      code: undefined,
      details: { success: false },
    };
    vi.spyOn(http, 'del').mockRejectedValue(apiErrorShape);

    const rejection = await projects.remove('p-1', { confirm: true }).then(
      () => { throw new Error('remove() resolved on a 409 — the refusal was swallowed'); },
      (e) => e
    );

    expect(rejection).toBe(apiErrorShape);
    expect(rejection instanceof Error).toBe(false); // the real shape, pinned
  });
});
