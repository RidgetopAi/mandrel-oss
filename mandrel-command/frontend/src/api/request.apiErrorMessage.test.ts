/**
 * an earlier task (Reviewer REJECT of 5730069) — does the server's sentence actually reach
 * the human?
 *
 * ── WHY THIS TEST IS WRITTEN AT THE ADAPTER SEAM ───────────────────────────────────────
 * The commit this fixes shipped a test that asserted the delete rejection carried the
 * blast-radius sentence — by stubbing `http.del` with `mockRejectedValue(new Error(...))`.
 * That test was GREEN and the claim was FALSE, because the REAL rejection is not an
 * `Error`: the shared axios interceptor rejects with a plain object literal
 * (`{ message, code, status, details } as ApiError`). The stub answered a contract the
 * real surface never produces — a lying double (tests-are-the-rock), and precisely the
 * "your guard and your product agree, and you can weaken one without the other noticing"
 * shape from a past incident.
 *
 * So this test refuses to hand-make the rejection. It replaces the axios ADAPTER — the
 * lowest layer, below every interceptor — with one that returns a real HTTP 409 carrying
 * the real backend body. Everything above it is production code: the response
 * interceptor, `ApiClient.delete`, `http.del`, `projectsApi.remove`. Whatever that
 * pipeline rejects with is what a browser gets, and it is what we assert on.
 *
 * The observable is deliberately "what string would the component render", because that
 * is the claim that was false. Asserting `apiErrorMessage` in isolation would have been
 * green under the old bug too.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AxiosAdapter } from 'axios';
import { apiClient } from '../services/api';
import { apiErrorMessage } from './request';
import { projectsApi } from './domains/projects';

/** The real sentence the gate composes from the schema-derived survey. */
const BLAST_RADIUS =
  '⚠️  Refusing to delete project "victim" without confirmation.\n' +
  'Deleting it will CASCADE-DELETE 7 owned rows (3 contexts, 4 tasks) across 24 ' +
  'project-owned cascading tables.';

/** The exact 409 body the Command backend controller returns on a refusal. */
const REFUSAL_BODY = {
  success: false,
  error: BLAST_RADIUS,
  message: BLAST_RADIUS,
  data: {
    requiresConfirmation: true,
    impact: { byTable: { contexts: 3, tasks: 4 }, total: 7, unmeasurable: [] },
  },
};

// The private axios instance every production request rides. Reached deliberately: the
// point is to leave the interceptor chain untouched and swap only the transport beneath it.
const instance = (apiClient as unknown as { _instance: { defaults: { adapter?: AxiosAdapter } } })
  ._instance;

/** An adapter that fails like a real server: a genuine AxiosError with a 409 response. */
const failingAdapter =
  (status: number, data: unknown): AxiosAdapter =>
  async (config) => {
    const err: any = new Error(`Request failed with status code ${status}`);
    err.isAxiosError = true;
    err.config = config;
    err.response = { status, statusText: '', data, headers: {}, config };
    throw err;
  };

describe('the server sentence survives the whole client pipeline', () => {
  let originalAdapter: AxiosAdapter | undefined;

  beforeEach(() => {
    originalAdapter = instance.defaults.adapter;
    // Keep the interceptor's console noise out of the report; it is not under test.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    instance.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  it('CHARACTERISES the real rejection: NOT an Error, but it does carry .message', async () => {
    // This is the measurement the previous commit never took. It is asserted rather than
    // described, so if the interceptor is ever changed to reject with a real Error, this
    // test tells the next reader immediately instead of silently agreeing.
    instance.defaults.adapter = failingAdapter(409, REFUSAL_BODY);

    const rejection = await projectsApi.remove('p-1').then(
      () => { throw new Error('remove() resolved — the adapter should have failed it'); },
      (e) => e
    );

    expect(typeof rejection).toBe('object');
    expect(rejection instanceof Error).toBe(false); // ← the entire bug, pinned
    expect((rejection as { message: string }).message).toBe(BLAST_RADIUS);
    expect((rejection as { status: number }).status).toBe(409);
  });

  it('THE USER-VISIBLE CLAIM: the rendered string is the blast radius, not the fallback', async () => {
    instance.defaults.adapter = failingAdapter(409, REFUSAL_BODY);

    const rejection = await projectsApi.remove('p-1').catch((e) => e);

    // Exactly what DangerZoneSection renders.
    expect(apiErrorMessage(rejection, 'Delete failed.')).toBe(BLAST_RADIUS);
    // …and the specific number the user needs to see.
    expect(apiErrorMessage(rejection, 'Delete failed.')).toContain('CASCADE-DELETE 7 owned rows');
  });

  it('ANTI-VACUOUS: the OLD `instanceof Error` expression, on this same real rejection, renders the generic fallback', async () => {
    // Without this, the test above could be green because of something unrelated. This
    // pins the DELTA: same rejection, old expression -> "Delete failed.", new helper ->
    // the sentence. It is the measurement that makes the fix a fix.
    instance.defaults.adapter = failingAdapter(409, REFUSAL_BODY);

    const rejection = await projectsApi.remove('p-1').catch((e) => e);

    const whatTheUserUsedToSee =
      rejection instanceof Error ? rejection.message : 'Delete failed.';
    expect(whatTheUserUsedToSee).toBe('Delete failed.');
    expect(apiErrorMessage(rejection, 'Delete failed.')).not.toBe(whatTheUserUsedToSee);
  });

  it('an mcp-server outage (500, no body message) is still legible — it falls back, it does not render "[object Object]"', async () => {
    // The delegated delete has no local fallback by design, so an unreachable mcp-server
    // surfaces here. The user should get the caller's sentence, never a stringified object.
    instance.defaults.adapter = failingAdapter(500, { success: false, error: 'Failed to delete project' });

    const rejection = await projectsApi.remove('p-1', { confirm: true }).catch((e) => e);
    const shown = apiErrorMessage(rejection, 'Delete failed.');

    expect(shown).not.toContain('[object Object]');
    expect(shown.trim().length).toBeGreaterThan(0);
  });

  it('a success:false envelope on a 2xx rejects with a real Error — and the SAME helper reads it', async () => {
    // The other shape that genuinely reaches these call sites: unwrapData throws a real
    // Error. One helper must be correct for both, or the sweep just moves the bug.
    instance.defaults.adapter = async (config) => ({
      data: { success: false, error: { message: 'Domain-level failure' } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });

    const rejection = await projectsApi.remove('p-1').catch((e) => e);

    expect(rejection instanceof Error).toBe(true);
    expect(apiErrorMessage(rejection, 'Delete failed.')).toBe('Domain-level failure');
  });
});

describe('apiErrorMessage — the values that slip past a naive reader', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object with no message', { status: 500 }],
    ['an object with a non-string message', { message: { nested: true } }],
    ['an object with a blank message', { message: '   ' }],
    ['an empty string', ''],
    ['an Error with an empty message', new Error('')],
  ])('falls back on %s', (_label, value) => {
    expect(apiErrorMessage(value, 'FALLBACK')).toBe('FALLBACK');
  });

  it('prefers a real message from either shape', () => {
    expect(apiErrorMessage(new Error('from an Error'), 'FALLBACK')).toBe('from an Error');
    expect(apiErrorMessage({ message: 'from an ApiError' }, 'FALLBACK')).toBe('from an ApiError');
    expect(apiErrorMessage('from a string', 'FALLBACK')).toBe('from a string');
  });
});
