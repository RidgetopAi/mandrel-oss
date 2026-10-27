/**
 * THE GLOBAL READS — the two requests that must NOT be narrowed by the pinned default
 * (Reviewer B4, an earlier epic §A4).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * Pinning the ambient `X-Project-ID` to the user's default narrows every request that
 * does not say otherwise — INCLUDING the two that exist to be global:
 *
 *   • `GET /api/projects` fills `allProjects`, which fills every `<ProjectSelect>` on all
 *     ten pages. Narrowed, it returns ONE row: a selector offering only the project you
 *     are already on. Nothing errors and nothing looks broken; the feature is just inert.
 *   • `GET /api/resolve/:id` is the `/r/<id8>` short-link resolver. Narrowed, a link to a
 *     record outside your default project 404s — and this work deleted the global
 *     switcher, which was the only control that could unwedge you (spec §A4).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS ASSERTS
 * ════════════════════════════════════════════════════════════════════════════════════
 * Not "the helper returns the right object" — that is the isolation-only testing that let
 * B1 ship. These drive the REAL `api.projects.list()` / `resolveNavRecord()` through the
 * REAL shared axios instance with the ambient project deliberately SET, and read the
 * params off the config the adapter is handed. The backend half — that the sentinel
 * actually widens the result and that F-04 still denies an ungranted project — is
 * asserted against real planted rows in `backend/__tests__/projectListGlobalRead.db.test.ts`.
 *
 * The header is asserted PRESENT alongside the sentinel on purpose: the fix must not be
 * "stop sending the header", which is the permanently-unscoped state §A2 makes unreachable.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import { api } from '../index';
import { resolveNavRecord } from '../resolveClient';
import { apiClient } from '../../services/api';
import { apiConfig } from '../../config/apiConfig';
import { ALL_PROJECTS_SCOPE, globalReadConfig } from './projectScope';

const AMBIENT_PROJECT = 'bbbbbbbb-2222-4222-8222-222222222222';

const captured: InternalAxiosRequestConfig[] = [];
let originalAdapter: unknown;

beforeAll(() => {
  originalAdapter = apiClient.instance.defaults.adapter;
  apiClient.instance.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    captured.push(config);
    return {
      data: { success: true, data: { projects: [] } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiClient.instance.defaults.adapter = originalAdapter as any;
});

beforeEach(() => {
  captured.length = 0;
  localStorage.clear();
  // THE PINNED DEFAULT. Every assertion below is only meaningful because the ambient
  // header is set — that is the state that produced the one-option selector.
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: AMBIENT_PROJECT }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: AMBIENT_PROJECT }));
});

afterEach(() => localStorage.clear());

const sentParams = (): Record<string, unknown> =>
  (captured.at(-1)?.params ?? {}) as Record<string, unknown>;
const sentHeader = (): unknown =>
  (captured.at(-1)?.headers as Record<string, unknown> | undefined)?.[apiConfig.projectHeader];

describe('api.projects.list — the ProjectSelect option feed is GLOBAL by construction', () => {
  it('sends the explicit project_id=all sentinel', async () => {
    await api.projects.list();
    expect(sentParams().project_id).toBe(ALL_PROJECTS_SCOPE);
  });

  it('still sends the ambient header — the fix is EXPLICITLY unscoped, not un-headered', async () => {
    // Dropping the header instead would re-open the §A2 permanently-unscoped state that
    // the four-rung ladder exists to close. The sentinel is a query value; both go.
    await api.projects.list();
    expect(sentHeader()).toBe(AMBIENT_PROJECT);
  });

  it('a caller cannot accidentally re-narrow it — the domain sentinel wins', async () => {
    // If a page ever passes its own `scope()` here (plausible: someone copies the pattern
    // from a scoped read), the list must stay global or the selector loses its options.
    await api.projects.list({ headers: { [apiConfig.projectHeader]: AMBIENT_PROJECT } });
    expect(sentParams().project_id).toBe(ALL_PROJECTS_SCOPE);
  });
});

describe('resolveNavRecord — the /r/<id8> navigation surface is GLOBAL (§A4)', () => {
  it('sends the sentinel so a short link can reach outside the default project', async () => {
    await resolveNavRecord('abcd1234');
    expect(sentParams().project_id).toBe(ALL_PROJECTS_SCOPE);
    expect(sentHeader()).toBe(AMBIENT_PROJECT);
  });
});

describe('globalReadConfig — the primitive, on the values that slip through', () => {
  it('preserves a base config rather than replacing it', () => {
    const cfg = globalReadConfig({ headers: { 'X-Test': '1' }, timeout: 99 });
    expect(cfg.headers).toEqual({ 'X-Test': '1' });
    expect(cfg.timeout).toBe(99);
    expect((cfg.params as Record<string, unknown>).project_id).toBe(ALL_PROJECTS_SCOPE);
  });

  it('merges into existing params instead of dropping them', () => {
    const cfg = globalReadConfig({ params: { limit: 5 } });
    expect(cfg.params).toEqual({ limit: 5, project_id: ALL_PROJECTS_SCOPE });
  });

  it('is correct with NO base at all (the absent population)', () => {
    expect(globalReadConfig().params).toEqual({ project_id: ALL_PROJECTS_SCOPE });
  });
});
