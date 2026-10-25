/**
 * Punch form — the STRUCTURED contract proof (an earlier decision /
 * the Punch List loop decision; DEPENDS ON the API shape from an earlier task). This is the literal
 * acceptance-criteria walkthrough for the punch author's DONE WHEN clauses, run against
 * a MOCKED unified api client so the wire payload — never a screenshot — is the proof
 * of what actually gets sent:
 *
 *   1. an incomplete clause (owner unset, or a lane clause with empty proof) keeps the
 *      Ready submit disabled and names the missing field inline; filling it enables it.
 *   2. the submit payload carries `punch.doneWhen` as `{text, owner, proof?}[]` plus
 *      `proofKind` and `touches`, under the top-level `punch` key, and `dependencies` at
 *      the top level — `metadata.punch` is never the channel.
 *   3. a genuine server refusal (PunchIncompleteError) renders its message VERBATIM.
 *   4. loading a punch with a legacy string `doneWhen` yields ONE row with owner unset
 *      and Ready disabled.
 *
 * Same raw react-dom harness the rest of the Punch suite uses (no testing-library dep
 * in this package).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const P_RIVERBEND = 'aaaa1111-1111-4111-8111-aaaa11111111';
const mockAllProjects = [{ id: P_RIVERBEND, name: 'riverbend' }];

vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined, allProjects: mockAllProjects }),
  useEffectiveProjectId: () => undefined,
}));

vi.mock('../api', () => ({
  api: {
    tasks: { create: vi.fn(), update: vi.fn() },
    attachments: { upload: vi.fn(), list: vi.fn(), blob: vi.fn(), remove: vi.fn() },
  },
}));

vi.mock('./punch/downscale', () => ({ downscaleImage: vi.fn(async (f: File) => f) }));

import { api } from '../api';
import { PunchForm } from './punch/PunchForm';

const mockApi = api as unknown as {
  tasks: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  attachments: { upload: ReturnType<typeof vi.fn> };
};

const NEW_ID = 'cccccccc-0000-4000-8000-000000000001';

let container: HTMLDivElement;
let root: Root;
let onFiled: ReturnType<typeof vi.fn>;

function mount(props: Partial<React.ComponentProps<typeof PunchForm>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  onFiled = vi.fn();
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PunchForm pageProjectId={P_RIVERBEND} onFiled={onFiled} onCancel={() => {}} {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const submitBtn = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;
const goal = () => container.querySelector('input[aria-label="Goal"]') as HTMLInputElement;
const clauseText = (n: number) => container.querySelector(`input[aria-label="Done when ${n}"]`) as HTMLInputElement;
const clauseProof = (n: number) => container.querySelector(`input[aria-label="Proof ${n}"]`) as HTMLInputElement | null;
const ownerGroup = (n: number) => container.querySelector(`[aria-label="Owner ${n}"]`) as HTMLElement;
const ownerButton = (n: number, label: 'Lane' | 'Human') =>
  Array.from(ownerGroup(n).querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.tasks.create.mockResolvedValue({ id: NEW_ID, project_id: P_RIVERBEND });
  mockApi.tasks.update.mockResolvedValue({ id: NEW_ID, stage: 'ready' });
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('DONE WHEN (1) — an incomplete clause keeps Ready disabled with the field named inline', () => {
  it('owner unset: disabled + "Choose lane or human" inline; choosing an owner enables it', () => {
    mount();
    act(() => type(goal(), 'Save button dead'));
    act(() => type(clauseText(1), 'Save works'));
    expect(submitBtn().disabled).toBe(true);
    expect(container.textContent).toContain('Choose lane or human');

    act(() => ownerButton(1, 'Human').click());
    expect(submitBtn().disabled).toBe(false);
    expect(container.textContent).not.toContain('Choose lane or human');
  });

  it('a lane clause with empty proof: disabled + "Proof is required for a lane clause" inline; filling it enables it', () => {
    mount();
    act(() => type(goal(), 'Save button dead'));
    act(() => type(clauseText(1), 'Save works'));
    act(() => ownerButton(1, 'Lane').click());
    expect(submitBtn().disabled).toBe(true);
    expect(container.textContent).toContain('Proof is required for a lane clause');

    act(() => type(clauseProof(1)!, 'mandrel-command/frontend/src/pages/Punch.test.tsx'));
    expect(submitBtn().disabled).toBe(false);
    expect(container.textContent).not.toContain('Proof is required for a lane clause');
  });
});

describe('DONE WHEN (2) — the submit payload carries the structured contract', () => {
  it('punch.doneWhen is {text,owner,proof?}[] + proofKind + touches under `punch`; dependencies is top-level; metadata.punch is absent', async () => {
    mount();
    act(() => type(goal(), 'Save button dead'));
    act(() => type(clauseText(1), 'Save works'));
    act(() => ownerButton(1, 'Lane').click());
    act(() => type(clauseProof(1)!, 'mandrel-command/frontend/src/pages/Punch.test.tsx'));

    const touchesBox = container.querySelector('textarea[aria-label="Touches"]') as HTMLTextAreaElement;
    const depsBox = container.querySelector('textarea[aria-label="Dependencies"]') as HTMLTextAreaElement;
    act(() => type(touchesBox, 'src/pages/punch/PunchForm.tsx, src/pages/punch/ClauseRows.tsx'));
    act(() => type(depsBox, '28ad3543'));

    act(() => submitBtn().click());
    await settle();

    expect(mockApi.tasks.create).toHaveBeenCalledTimes(1);
    const [payload] = mockApi.tasks.create.mock.calls[0];

    expect(payload.punch).toEqual({
      doneWhen: [
        {
          text: 'Save works',
          owner: 'lane',
          proof: 'mandrel-command/frontend/src/pages/Punch.test.tsx',
        },
      ],
      proofKind: 'browser',
      source: 'form',
      touches: ['src/pages/punch/PunchForm.tsx', 'src/pages/punch/ClauseRows.tsx'],
    });
    expect(payload.dependencies).toEqual(['28ad3543']);
    expect(payload.metadata).toBeUndefined();
    expect('punch' in payload).toBe(true);
  });
});

describe('DONE WHEN (3) — a server refusal renders its message verbatim', () => {
  it('PunchIncompleteError (mocked) shows byte-identical text beside the form', async () => {
    const verbatim =
      "task_update: refusing to set stage='ready' — missing: doneWhen[0].proof. NOTHING WAS WRITTEN. A stage='ready' task must carry a non-empty title, metadata.punch.doneWhen, metadata.punch.proofKind, and a resolved project before it can be picked up. [PUNCH_INCOMPLETE]";
    mockApi.tasks.update.mockRejectedValue({
      message: verbatim,
      code: 'PUNCH_INCOMPLETE',
      status: 400,
      details: { code: 'PUNCH_INCOMPLETE', missing: ['doneWhen[0].proof'] },
    });
    mount();
    act(() => type(goal(), 'Save button dead'));
    act(() => type(clauseText(1), 'Save works'));
    act(() => ownerButton(1, 'Human').click());
    act(() => submitBtn().click());
    await settle();

    expect(onFiled).toHaveBeenCalledWith(NEW_ID, 'draft');
    expect(container.textContent).toContain(verbatim);
  });
});

describe('DONE WHEN (4) — loading a legacy string doneWhen', () => {
  it('yields one row with owner unset and Ready disabled', () => {
    mount({ initialPunch: { doneWhen: 'the login flow no longer 500s', proofKind: 'test' } });
    expect(clauseText(1).value).toBe('the login flow no longer 500s');
    expect(clauseText(2)).toBeNull();
    expect(ownerGroup(1).querySelector('[aria-checked="true"]')).toBeNull();

    act(() => type(goal(), 'Login 500'));
    expect(submitBtn().disabled).toBe(true);
  });
});
