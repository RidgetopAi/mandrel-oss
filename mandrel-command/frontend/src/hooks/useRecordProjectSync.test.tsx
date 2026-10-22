/**
 * useRecordProjectSync — the DIRECTIONALITY guard (Reviewer round-2 blocker 1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS SUITE EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * The hook re-points `?project=` at the record the reader is showing. The reader is
 * route-driven (`/tasks/:id`), so it stays mounted across a project change — and the
 * effect listed `projectId` in its dependencies. So picking project B while a record from
 * A was open re-ran the effect BECAUSE the project changed, it saw record(A) != page(B),
 * and it wrote A back. The selector looked dead on Contexts / Tasks / Decisions whenever a
 * record was open.
 *
 * The first test below is the reproduction, verbatim, and it FAILED before the fix with:
 *
 *     AFTER USER PICKED B, page project is: aaaaaaaa-1111-4111-8111-111111111111
 *     AssertionError: expected 'aaaa…' to be 'bbbb…'
 *
 * ── THE POPULATION THIS ENUMERATES, AND WHY IT IS WHOLE ──────────────────────────────
 * Scope: the hook's own decision table, driven directly rather than through a page. There
 * are exactly two inputs that can change — WHICH RECORD is open and WHAT PROJECT the page
 * is on — and the whole defect was that the hook could not tell them apart. So the five
 * cases below are that 2x2 plus the two third-state inputs (`undefined` record project,
 * non-selectable record project), and each one fails independently:
 *
 *   1. opening a record from another project DOES follow
 *   2. changing the selector while that record is open is NOT reverted   ← the defect
 *   3. opening a DIFFERENT record afterwards DOES follow again
 *   4. an unknown/undefined record project does nothing
 *   5. a non-selectable record project does nothing
 *
 * What it does NOT cover: that the three pages pass a STABLE selection id rather than a
 * query result that blinks across refetch. That is a call-site property (`selectedId` in
 * Contexts/Decisions/Tasks) and is stated as a contract in the hook's `@param`.
 *
 * `Decisions.scope.test.tsx` covers only the page-follows-record direction (case 1) and
 * would still have passed with this defect present — which is why this file exists rather
 * than an extra assertion there.
 *
 * Convention note: this repo has NO `@testing-library`; the harness is `createRoot` from
 * `react-dom/client` + `act` from `react`, as in `usePageProject.test.tsx`.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect } from 'vitest';
import { useRecordProjectSync } from './useRecordProjectSync';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
/** A project the user CANNOT select — it is deliberately absent from `projects`. */
const FORBIDDEN = 'cccccccc-3333-4333-8333-333333333333';

const RECORD_1 = 'record-1';
const RECORD_2 = 'record-2';

type Api = {
  projectId: string;
  setProjectId: (v: string) => void;
  setRecord: (id: string | null, projectId: string | undefined | null) => void;
  /** Drives the selectable list ARRIVING — the ProjectContext load, on the same instance. */
  setProjects: (p: { id: string; name: string }[]) => void;
};

/**
 * Mount the hook with a page project and a record, and hand back a handle that drives the
 * two things a user can actually do: move the selector, and open a different record.
 */
async function mountHook(opts: {
  initialProjectId: string;
  recordId: string | null;
  recordProjectId: string | undefined | null;
  projects?: { id: string; name: string }[];
}) {
  const initialProjects = opts.projects ?? [
    { id: A, name: 'A' },
    { id: B, name: 'B' },
  ];
  let api: Api | null = null;

  function Harness() {
    const [projectId, setProjectId] = React.useState(opts.initialProjectId);
    const [projects, setProjects] = React.useState(initialProjects);
    const [record, setRecord] = React.useState<{
      id: string | null;
      projectId: string | undefined | null;
    }>({ id: opts.recordId, projectId: opts.recordProjectId });

    api = {
      projectId,
      setProjectId,
      setProjects,
      setRecord: (id, pid) => setRecord({ id, projectId: pid }),
    };

    useRecordProjectSync(
      { projectId, setProjectId, projects } as never,
      record.projectId,
      record.id,
    );
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });

  return {
    get api() {
      return api!;
    },
    unmount: () => act(() => root!.unmount()),
  };
}

describe('REPRO (Reviewer blocker 1): the selector vs an open record', () => {
  it('a user picking B while a record from A is open must STAY on B', async () => {
    const projects = [
      { id: A, name: 'A' },
      { id: B, name: 'B' },
    ];
    let api: { projectId: string; setProjectId: (v: string) => void } | null = null;

    function Harness() {
      const [projectId, setProjectId] = React.useState(A);
      api = { projectId, setProjectId };
      // the reader is showing a record that lives in project A
      useRecordProjectSync(
        { projectId, setProjectId, projects } as never,
        A,
        RECORD_1,
      );
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
    });

    expect(api!.projectId).toBe(A);
    await act(async () => {
      api!.setProjectId(B);
    }); // the user picks B
    expect(api!.projectId).toBe(B); // the user's choice must survive
    act(() => root!.unmount());
  });
});

describe('useRecordProjectSync — the page follows the RECORD, never the project', () => {
  it('1. opening a record from another project DOES follow it', async () => {
    // page on A, a `/r/<id8>` link lands on a record that lives in B
    const h = await mountHook({ initialProjectId: A, recordId: RECORD_1, recordProjectId: B });
    expect(h.api.projectId).toBe(B);
    h.unmount();
  });

  it('2. changing the selector while that record is open is NOT reverted (THE DEFECT)', async () => {
    const h = await mountHook({ initialProjectId: A, recordId: RECORD_1, recordProjectId: A });
    await act(async () => {
      h.api.setProjectId(B);
    });
    expect(h.api.projectId).toBe(B);

    // and it stays put across further re-renders — the revert used to land a tick later
    await act(async () => {});
    expect(h.api.projectId).toBe(B);
    h.unmount();
  });

  it('2b. it is not reverted after the page followed the record first', async () => {
    // the full user story: land on a B record from page A (follow), then choose A yourself
    const h = await mountHook({ initialProjectId: A, recordId: RECORD_1, recordProjectId: B });
    expect(h.api.projectId).toBe(B); // followed

    await act(async () => {
      h.api.setProjectId(A);
    }); // user overrides
    await act(async () => {});
    expect(h.api.projectId).toBe(A); // and the override sticks
    h.unmount();
  });

  it('3. opening a DIFFERENT record afterwards DOES follow again', async () => {
    const h = await mountHook({ initialProjectId: A, recordId: RECORD_1, recordProjectId: A });
    await act(async () => {
      h.api.setProjectId(B);
    });
    expect(h.api.projectId).toBe(B);

    // a new record is opened, and it lives in A — a NEW record identity, so follow
    await act(async () => {
      h.api.setRecord(RECORD_2, A);
    });
    expect(h.api.projectId).toBe(A);
    h.unmount();
  });

  it('3b. closing the reader and re-opening the same record follows again', async () => {
    const h = await mountHook({ initialProjectId: A, recordId: RECORD_1, recordProjectId: B });
    expect(h.api.projectId).toBe(B);

    await act(async () => {
      h.api.setProjectId(A);
    }); // user goes back to A
    await act(async () => {
      h.api.setRecord(null, undefined);
    }); // reader closed
    expect(h.api.projectId).toBe(A);

    await act(async () => {
      h.api.setRecord(RECORD_1, B);
    }); // re-opened
    expect(h.api.projectId).toBe(B);
    h.unmount();
  });

  it('4. an UNKNOWN (undefined) record project does nothing — C1 third state', async () => {
    const h = await mountHook({
      initialProjectId: A,
      recordId: RECORD_1,
      recordProjectId: undefined,
    });
    expect(h.api.projectId).toBe(A);

    // ...and when the detail finally resolves to B, it follows THEN — the undefined pass
    // must not have consumed the record's one decision
    await act(async () => {
      h.api.setRecord(RECORD_1, B);
    });
    expect(h.api.projectId).toBe(B);
    h.unmount();
  });

  it('4b. a null record project also does nothing', async () => {
    const h = await mountHook({ initialProjectId: A, recordId: RECORD_1, recordProjectId: null });
    expect(h.api.projectId).toBe(A);
    h.unmount();
  });

  it('5. a NON-SELECTABLE record project does nothing', async () => {
    // usePageProject would ignore the value anyway; writing it would leave a `?project=`
    // that says one thing while the page shows another
    const h = await mountHook({
      initialProjectId: A,
      recordId: RECORD_1,
      recordProjectId: FORBIDDEN,
    });
    expect(h.api.projectId).toBe(A);
    h.unmount();
  });

  /**
   * C3: the EMPTY population — the selectable list has not loaded yet. The load must
   * happen on the SAME hook instance, or the assertion is hollow: mounting a second
   * harness with a full list only re-proves test 1, and a mutation removing this deferral
   * survives it (measured — probe M6 stayed GREEN against exactly that mistake).
   */
  it('5b. an EMPTY selectable list defers rather than deciding, and follows once it loads', async () => {
    const h = await mountHook({
      initialProjectId: A,
      recordId: RECORD_1,
      recordProjectId: B,
      projects: [],
    });
    expect(h.api.projectId).toBe(A); // nothing decided on an empty population

    // the ProjectContext load lands — the record's one decision must NOT have been burnt
    await act(async () => {
      h.api.setProjects([
        { id: A, name: 'A' },
        { id: B, name: 'B' },
      ]);
    });
    expect(h.api.projectId).toBe(B);
    h.unmount();
  });

  it('6. no record open at all does nothing', async () => {
    const h = await mountHook({ initialProjectId: A, recordId: null, recordProjectId: undefined });
    expect(h.api.projectId).toBe(A);
    h.unmount();
  });
});
