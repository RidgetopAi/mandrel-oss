/**
 * PROJECT VISIBILITY — unit tests.
 *
 * Covers the two visibility surfaces WITHOUT a DB:
 *   FIX #1 — the write-echo formatter: names the resolved project (name + id8), and renders
 *            the DEFAULTED case DISTINCTLY from the manual/explicit case.
 *   FIX #2 — the initialize instructions builder: DYNAMIC (names the project) vs STATIC.
 *
 * The pure formatters (config/projectEchoConfig.ts) are tested directly. The resolver
 * (utils/projectEcho.ts) is tested with a MOCKED projectHandler so no DB is touched, proving
 * the explicit-vs-defaulted wiring + the never-throw degradation.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

import {
  formatWriteEcho,
  formatInstructions,
  toId8,
  DEFAULT_PROJECT_HINT,
  BOUND_PROJECT_HINT,
  BOUND_CLIENT_CAVEAT,
  PROJECT_ID8_LEN,
} from '../config/projectEchoConfig.js';

// ── Mock the project handler so the resolver never touches the DB ──────────────────────
const getProject = vi.fn();
const getSessionInfo = vi.fn();
const initializeSession = vi.fn();
const getCurrentProject = vi.fn();

vi.mock('../handlers/project.js', () => ({
  projectHandler: {
    getProject: (...a: any[]) => getProject(...a),
    getSessionInfo: (...a: any[]) => getSessionInfo(...a),
    initializeSession: (...a: any[]) => initializeSession(...a),
    getCurrentProject: (...a: any[]) => getCurrentProject(...a),
  },
}));

// ── Mock the ambient scope so the BINDING branches are unit-testable without a DB ──────
// (the same branches are exercised for real, against real Postgres and a real header, in
// src/tests/projectScopeChokePoint.contract.test.ts PART G — this file pins the LOGIC.)
// Takes no arguments by design — the binding it resolves comes from the AMBIENT scope, not
// from a parameter, which is the whole point of the choke point.
const boundProjectInForce = vi.fn(async () => null as any);
vi.mock('../services/effectiveProjectScope.js', () => ({
  boundProjectInForce: () => boundProjectInForce(),
}));

// Imported AFTER the mock is declared (vi.mock is hoisted, so this is safe).
const { buildWriteEcho, resolveInstructions } = await import('../utils/projectEcho.js');

const FULL_ID = '8c6254aa-1111-2222-3333-444455556666';

beforeEach(() => {
  vi.clearAllMocks();
  // DEFAULT = UNBOUND, so every legacy expectation below is byte-identical to before the
  // binding branches existed.
  boundProjectInForce.mockResolvedValue(null as any);
});

describe('FIX #1 — write-echo formatter (pure)', () => {
  test('manual/explicit target: names project + id8, NO default hint', () => {
    const line = formatWriteEcho('HEx', '8c6254aa', /* defaulted */ false);
    expect(line).toContain("'HEx'");
    expect(line).toContain('(8c6254aa)');
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);
  });

  test('DEFAULTED target renders DISTINCTLY (extra noticeable hint)', () => {
    const manual = formatWriteEcho('HEx', '8c6254aa', false);
    const defaulted = formatWriteEcho('HEx', '8c6254aa', true);
    expect(defaulted).not.toEqual(manual);
    expect(defaulted).toContain(DEFAULT_PROJECT_HINT);
    expect(defaulted).toContain('project_switch');
  });

  test('toId8 truncates the UUID to the configured id8 length', () => {
    expect(toId8(FULL_ID)).toBe(FULL_ID.substring(0, PROJECT_ID8_LEN));
    expect(toId8(FULL_ID)).toBe('8c6254aa');
  });
});

describe('FIX #2 — instructions builder (pure)', () => {
  test('DYNAMIC: names the active project', () => {
    const s = formatInstructions('HEx');
    expect(s).toContain('HEx');
    expect(s.toLowerCase()).toContain('active');
    expect(s).toContain('project_switch');
  });

  test('STATIC: no project name, points at project_current', () => {
    const s = formatInstructions(undefined);
    expect(s).toContain('project_current');
    expect(s).toContain('ACTIVE project');
  });

  test('DYNAMIC differs from STATIC', () => {
    expect(formatInstructions('HEx')).not.toEqual(formatInstructions(undefined));
  });

  test('blank/whitespace name degrades to STATIC', () => {
    expect(formatInstructions('   ')).toEqual(formatInstructions(undefined));
    expect(formatInstructions(null)).toEqual(formatInstructions(undefined));
  });
});

describe('FIX #1 — buildWriteEcho resolver (mocked handler, no DB)', () => {
  test('explicit projectId arg → NOT defaulted (never reads session override)', async () => {
    getProject.mockResolvedValue({ id: FULL_ID, name: 'HEx' });
    const line = await buildWriteEcho(FULL_ID, 'conn-1', /* explicit */ true);
    expect(line).toContain("'HEx'");
    expect(line).toContain('(8c6254aa)');
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);
    // Explicit target must NOT consult manualOverride at all.
    expect(getSessionInfo).not.toHaveBeenCalled();
  });

  test('session-resolved + manualOverride TRUE → NOT defaulted', async () => {
    getProject.mockResolvedValue({ id: FULL_ID, name: 'HEx' });
    getSessionInfo.mockReturnValue({ currentProjectId: FULL_ID, manualOverride: true });
    const line = await buildWriteEcho(FULL_ID, 'conn-1', false);
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);
  });

  test('session-resolved + NO manual override → DEFAULTED (loud hint)', async () => {
    getProject.mockResolvedValue({ id: FULL_ID, name: 'HEx' });
    getSessionInfo.mockReturnValue({ currentProjectId: FULL_ID, manualOverride: false });
    const line = await buildWriteEcho(FULL_ID, 'conn-1', false);
    expect(line).toContain(DEFAULT_PROJECT_HINT);
  });

  test('undefined projectId → empty string (append nothing)', async () => {
    const line = await buildWriteEcho(undefined, 'conn-1', false);
    expect(line).toBe('');
  });

  test('never throws — a handler error degrades to empty string', async () => {
    getProject.mockRejectedValue(new Error('db down'));
    getSessionInfo.mockReturnValue({ manualOverride: false });
    const line = await buildWriteEcho(FULL_ID, 'conn-1', false);
    expect(line).toBe('');
  });
});

describe('FIX #2 — resolveInstructions resolver (mocked handler, no DB)', () => {
  test('with a connection + resolvable project → DYNAMIC (named)', async () => {
    initializeSession.mockResolvedValue(undefined);
    getCurrentProject.mockResolvedValue({ id: FULL_ID, name: 'HEx' });
    const s = await resolveInstructions('conn-1');
    expect(s).toContain('HEx');
    expect(s).toEqual(formatInstructions('HEx'));
  });

  test('no connection id → STATIC (no DB call)', async () => {
    const s = await resolveInstructions(undefined);
    expect(s).toEqual(formatInstructions(undefined));
    expect(initializeSession).not.toHaveBeenCalled();
  });

  test('resolution error → STATIC (never throws)', async () => {
    initializeSession.mockRejectedValue(new Error('db down'));
    const s = await resolveInstructions('conn-1');
    expect(s).toEqual(formatInstructions(undefined));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * BINDING-AWARE SURFACES (an earlier decision — Reviewer nits N5/N8)
 *
 * "No surface tells a bound client the wrong thing." Two surfaces were still doing it:
 *   N5 — the WRITE ECHO derived `defaulted` from `manualOverride`, which a binding never sets.
 *   N8 — the connect INSTRUCTIONS still said "use project_switch to change", which a bound
 *        client is REJECTED for calling.
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('N5 — the write echo tells a BOUND client its write was BOUND, not defaulted', () => {
  test('formatter: the BOUND rendering names the binding surface and drops the default hint', () => {
    const line = formatWriteEcho('HEx', '8c6254aa', /* defaulted */ false, 'x-mandrel-project header');
    expect(line).toContain("'HEx'");
    expect(line).toContain(BOUND_PROJECT_HINT);
    expect(line).toContain('x-mandrel-project header');
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);
  });

  test('formatter: BOUND WINS over defaulted (the precedence lives in one place)', () => {
    // The whole defect in one assertion: a bound target must never render the hint that says
    // "default project … project_switch if this is wrong" — a call that hard-fails while bound.
    const line = formatWriteEcho('HEx', '8c6254aa', /* defaulted */ true, 'MANDREL_PROJECT_ID env var');
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);
    expect(line).not.toContain('project_switch');
    expect(line).toContain('MANDREL_PROJECT_ID env var');
  });

  test('formatter: with NO binding label the two legacy renderings are byte-identical', () => {
    // default == today. The 4th argument is the only thing that changes anything.
    expect(formatWriteEcho('HEx', '8c6254aa', false, undefined)).toBe(
      `Project: 'HEx' (8c6254aa)`
    );
    expect(formatWriteEcho('HEx', '8c6254aa', true, undefined)).toBe(
      `Project: 'HEx' (8c6254aa) — ${DEFAULT_PROJECT_HINT}`
    );
  });

  test('resolver: a bound write is NOT defaulted even when nothing was explicit', async () => {
    // THE LATENT DEFECT, isolated. `explicit` is false here — the shape a write tool that
    // declares no projectId param produces, and the shape every write tool produces the moment
    // materialisation stops covering it. Pre-fix this read manualOverride (never set by a
    // binding) and labelled a deliberately-bound write "⚠️ default project".
    getProject.mockResolvedValue({ id: FULL_ID, name: 'HEx' });
    getSessionInfo.mockReturnValue({ currentProjectId: FULL_ID, manualOverride: false });
    boundProjectInForce.mockResolvedValue({
      id: FULL_ID,
      name: 'HEx',
      originLabel: 'x-mandrel-project header',
      origin: 'header',
    } as any);

    const line = await buildWriteEcho(FULL_ID, 'conn-1', /* explicit */ false);
    expect(line).not.toContain(DEFAULT_PROJECT_HINT);
    expect(line).toContain(BOUND_PROJECT_HINT);
    expect(line).toContain('x-mandrel-project header');
  });

  test('resolver: a binding pointing SOMEWHERE ELSE never claims the write was bound', async () => {
    // Structurally unreachable today (the route gate throws ProjectBindingMismatchError first),
    // so this pins that the echo reports WHERE THE ROW WENT rather than what the binding said.
    getProject.mockResolvedValue({ id: FULL_ID, name: 'HEx' });
    getSessionInfo.mockReturnValue({ currentProjectId: FULL_ID, manualOverride: false });
    boundProjectInForce.mockResolvedValue({
      id: '99999999-0000-0000-0000-000000000000',
      name: 'Elsewhere',
      originLabel: 'x-mandrel-project header',
      origin: 'header',
    } as any);

    const line = await buildWriteEcho(FULL_ID, 'conn-1', false);
    expect(line).not.toContain(BOUND_PROJECT_HINT);
    expect(line).not.toContain('Elsewhere');
    expect(line).toContain("'HEx'");
  });
});

describe('N8 — the connect instructions finish the sentence for a BOUND client', () => {
  test('BOUND: names the binding surface and does NOT advise project_switch', () => {
    const s = formatInstructions('HEx', 'x-mandrel-project header');
    expect(s).toContain('HEx');
    expect(s).toContain('x-mandrel-project header');
    // The claim the shipped string made that was false for every bound client.
    expect(s).not.toContain('use project_switch to change');
    // It must still SAY what happens, rather than going silent about switching.
    expect(s).toContain('REJECTED');
  });

  test('UNBOUND dynamic is byte-identical with and without the (absent) label', () => {
    expect(formatInstructions('HEx', undefined)).toBe(formatInstructions('HEx'));
    expect(formatInstructions('HEx')).toContain('use project_switch to change');
  });

  test('BOUND differs from the unbound dynamic form', () => {
    expect(formatInstructions('HEx', 'x-mandrel-project header')).not.toEqual(
      formatInstructions('HEx')
    );
  });

  test('STATIC carries the bound-client caveat (the stdio Server emits STATIC unconditionally)', () => {
    // A stdio client binds itself with MANDREL_PROJECT_ID, and MandrelMcpServer's constructor
    // emits formatInstructions(undefined) for it — so the STATIC form has to be true for a
    // bound client too, or the caveat is missing exactly where the binding is invisible.
    const s = formatInstructions(undefined);
    expect(s).toContain('project_current');
    expect(s).toContain(BOUND_CLIENT_CAVEAT);
  });

  test('resolver: a bound client gets the BOUND form (with the origin label)', async () => {
    boundProjectInForce.mockResolvedValue({
      id: FULL_ID,
      name: 'HEx',
      originLabel: 'MANDREL_PROJECT_ID env var',
      origin: 'env',
    } as any);

    const s = await resolveInstructions('conn-1');
    expect(s).toEqual(formatInstructions('HEx', 'MANDREL_PROJECT_ID env var'));
    // A binding must never take the rung-3 path — that path AUTO-PINS a project (see
    // resolveInstructions' own note), which is a side effect a binding must not cause.
    expect(initializeSession).not.toHaveBeenCalled();
  });
});
