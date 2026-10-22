/**
 * sessionStartBodyGovernsProject — the mcp-server half.
 *
 * The Command UI's NewSessionModal tells its reader that the BODY's `projectId` decides
 * the new session's project and that `X-Project-ID` does not. The Command backend half
 * of that claim (its proxy drops the header) is pinned in
 * `mandrel-command/backend/src/__tests__/sessionStartBodyGovernsProject.test.ts`.
 *
 * This is the other half: even if the header DID arrive, this controller would not read
 * it. Asserted here rather than inferred from the proxy, because "nothing forwards it"
 * and "nothing reads it" are independent facts and either one can be changed alone.
 *
 * DB-free: the handler the controller delegates to is mocked, so this reads the ARGUMENT
 * the controller passes — the value that becomes the session's project — rather than a
 * row. The controller is imported DYNAMICALLY (the bridgeAuth.test.ts pattern): a static
 * import is ESM-hoisted above the env stubs, and its transitive config/database.ts
 * throws when DATABASE_NAME is unset at import time.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Request, Response } from 'express';

/** The project a browser/proxy might pin on the request. Must be ignored here. */
const HEADER_PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';
/** The project the request BODY names. Must be what the session is created against. */
const BODY_PROJECT = 'bbbbbbbb-2222-4222-8222-222222222222';

const startSession = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ success: true, data: { session_id: 'session-1' } })),
);

vi.mock('../handlers/sessionAnalytics.js', () => ({
  SessionAnalyticsHandler: { startSession },
  default: { startSession },
}));

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_session_project_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};
const savedEnv: Record<string, string | undefined> = {};

type ControllerCtor = typeof import('../api/controllers/sessionAnalyticsController.js').SessionAnalyticsController;
let SessionAnalyticsController: ControllerCtor;

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  ({ SessionAnalyticsController } = await import(
    '../api/controllers/sessionAnalyticsController.js'
  ));
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The controller's first positional argument IS the project the session is created in. */
const projectPassedToHandler = (): unknown => startSession.mock.calls[0]?.[0];

function fakeRes(): Response {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response;
}

function fakeReq(body: Record<string, unknown>, headers: Record<string, string>): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    body,
    headers: lower,
    header: (name: string) => lower[name.toLowerCase()],
    get: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

beforeEach(() => {
  startSession.mockClear();
});

describe('POST /api/v2/sessions/start — the project comes from the BODY', () => {
  it('creates the session against the body project, not a conflicting X-Project-ID', async () => {
    const controller = new SessionAnalyticsController();
    await controller.startSession(
      fakeReq({ projectId: BODY_PROJECT, title: 'from the modal' }, {
        'X-Project-ID': HEADER_PROJECT,
      }),
      fakeRes(),
    );

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(projectPassedToHandler()).toBe(BODY_PROJECT);
    expect(projectPassedToHandler()).not.toBe(HEADER_PROJECT);
  });

  it('passes NO project when the body names none, even with the header present', async () => {
    // The "auto-detect / unassigned" case: the handler's own detection runs. Reading the
    // header here instead would make the modal's field a suggestion rather than the
    // mechanism, which is the claim the UI paragraph is not allowed to make.
    const controller = new SessionAnalyticsController();
    await controller.startSession(
      fakeReq({ title: 'no project named' }, { 'X-Project-ID': HEADER_PROJECT }),
      fakeRes(),
    );

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(projectPassedToHandler()).toBeUndefined();
  });
});
