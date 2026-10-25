/**
 * an earlier task (Reviewer REJECT of 573f00d) — the LAST HOP.
 *
 * `request.apiErrorMessage.test.ts` proves the helper turns the real rejection into the
 * server's sentence. That is necessary and NOT sufficient: it would stay green if
 * DangerZoneSection never called the helper. A guard that tests the utility instead of the
 * adoption is the "your guard and your product agree, and you can weaken one without the
 * other noticing" shape — so this one renders the REAL component, fails the
 * REAL delete with the REAL rejection shape, and reads the DOM the user would look at.
 *
 * THE REJECTION SHAPE IS THE WHOLE POINT. The shared axios interceptor rejects with a
 * PLAIN OBJECT (`{message, status, ...}`), never an `Error`. The original code's
 * `mutation.error instanceof Error ? … : 'Delete failed.'` was therefore always false, and
 * the blast-radius sentence — the entire product of the 24-table survey — was replaced by
 * "Delete failed." at the last hop. So this file mocks with the object shape, and the
 * anti-vacuous case below asserts the OLD expression would still be showing the fallback
 * on this exact input. If someone reverts the component, that delta is what turns RED.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api', () => ({
  api: { projects: { remove: vi.fn() } },
}));

vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    currentProject: { id: 'p-victim', name: 'victim' },
    allProjects: [{ id: 'p-victim', name: 'victim' }],
    isAllProjects: false,
    setCurrentProject: vi.fn(),
    refreshProjects: vi.fn().mockResolvedValue([]),
  }),
  useEffectiveProjectId: () => 'p-victim',
}));

import { DangerZoneSection } from './DangerZoneSection';
import { api } from '../../api';

const mockRemove = (api as unknown as { projects: { remove: ReturnType<typeof vi.fn> } })
  .projects.remove;

/** The sentence the gate composes from the schema-derived survey — what must reach the DOM. */
const BLAST_RADIUS =
  '⚠️  Refusing to delete project "victim" without confirmation.\n' +
  'Deleting it will CASCADE-DELETE 7 owned rows (3 contexts, 4 tasks) across 24 ' +
  'project-owned cascading tables.';

/** EXACTLY what services/api.ts rejects with — a plain object literal, NOT an Error. */
const REAL_REJECTION = {
  message: BLAST_RADIUS,
  code: undefined,
  status: 409,
  details: { success: false, error: BLAST_RADIUS },
};

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DangerZoneSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function clickButton(text: string) {
  // The confirm Modal renders through createPortal into document.body, so it is NOT a
  // descendant of `container`. Search the whole document or the modal is invisible here.
  //
  // EXACT match, not `includes`: the trigger reads "Delete project…" and the modal's
  // confirm button reads "Delete project", so a substring match silently re-clicks the
  // TRIGGER and the mutation never fires — the test then asserts against a DOM where
  // nothing happened. (Measured: that is exactly what it did on the first run.)
  const btns = Array.from(document.querySelectorAll('button'));
  const btn = btns.find((b) => (b.textContent ?? '').trim() === text);
  if (!btn) {
    throw new Error(
      `button "${text}" not found; present: ${btns.map((b) => JSON.stringify((b.textContent ?? '').trim())).join(', ')}`,
    );
  }
  if ((btn as HTMLButtonElement).disabled) {
    throw new Error(`button "${text}" is DISABLED — the click would be a silent no-op`);
  }
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  // Let the mutation settle and re-render. react-query routes a rejection through
  // several microtasks plus a scheduler tick before `isError` flips, so a single
  // `Promise.resolve()` is not enough — the DOM would still show the pre-click state and
  // the assertions would read a screen where nothing happened.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Type the project name into the confirm field so the Delete button enables. */
async function typeConfirmation(value: string) {
  const input = document.querySelector('input[aria-label="Confirm project name"]') as HTMLInputElement;
  if (!input) throw new Error('confirm input not found');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Open the modal, confirm, and click Delete — the exact path a user takes. */
async function attemptDelete() {
  await clickButton('Delete project…');
  await typeConfirmation('victim');
  await clickButton('Delete project');
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('DangerZoneSection shows the server sentence, not a generic string', () => {
  it('POSITIVE CONTROL: a successful delete renders no error at all', async () => {
    // Without this, every assertion below could be satisfied by a component that is simply
    // broken and always shows an error box.
    mockRemove.mockResolvedValue(undefined);
    await mount();
    await attemptDelete();

    expect(document.body.textContent).not.toContain("Couldn't delete project");
    expect(mockRemove).toHaveBeenCalledWith('p-victim', { confirm: true });
  });

  it('renders the BLAST RADIUS from the real (non-Error) rejection shape', async () => {
    mockRemove.mockRejectedValue(REAL_REJECTION);
    await mount();
    await attemptDelete();

    const shown = document.body.textContent ?? '';
    expect(shown).toContain("Couldn't delete project");
    // The number the user actually needs before deciding.
    expect(shown).toContain('CASCADE-DELETE 7 owned rows');
    expect(shown).toContain('24 project-owned cascading tables');
    // …and NOT the generic string the old code always fell back to.
    expect(shown).not.toContain('Delete failed.');
  });

  it('ANTI-VACUOUS: the OLD expression, on this same rejection, would render the fallback', async () => {
    // Pins the DELTA rather than the end state. `REAL_REJECTION` is not an `Error`, so the
    // pre-fix ternary yields 'Delete failed.' — which is what the assertion above forbids.
    // If the rejection shape ever became a real Error, this would fail and tell the next
    // reader the premise changed, instead of quietly passing for a new reason.
    // eslint-disable-next-line no-restricted-syntax -- the BANNED expression is the SUBJECT here: this test exists to prove `instanceof Error` is false for the real rejection shape. Rewriting it with apiErrorMessage would delete the measurement.
    expect(REAL_REJECTION instanceof Error).toBe(false);
    // eslint-disable-next-line no-restricted-syntax -- reproduces the pre-fix expression verbatim to pin what the user USED to see; it must stay the broken form or it stops being a regression witness.
    const preFix = REAL_REJECTION instanceof Error ? (REAL_REJECTION as Error).message : 'Delete failed.';
    expect(preFix).toBe('Delete failed.');
  });

  it('an mcp-server outage still says something specific — never "[object Object]"', async () => {
    // The delegated delete has no local fallback by design, so an
    // unreachable gate surfaces to the user here.
    mockRejectionWithNoMessage();
    await mount();
    await attemptDelete();

    const shown = document.body.textContent ?? '';
    expect(shown).not.toContain('[object Object]');
    expect(shown).toContain('Delete failed.'); // the component's own fallback, deliberately
  });

  function mockRejectionWithNoMessage() {
    mockRemove.mockRejectedValue({ status: 500, details: {} });
  }
});
