/**
 * PunchForm — the file-a-punch flow end-to-end against a MOCKED
 * unified api client. Since an earlier task, `doneWhen` is a LIST of clause
 * rows (text / owner lane|human / proof) and the submit payload carries the STRUCTURED
 * contract: create(draft, punch.doneWhen=[...]) → upload(before) per photo →
 * update(stage:'ready'). Two things must never happen: a submit before every clause is
 * complete, and a lost punch when the server answers PUNCH_INCOMPLETE. Same raw
 * react-dom harness as the suite.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const P_COORDINATOR = 'aaaa1111-1111-4111-8111-aaaa11111111';
const mockAllProjects = [{ id: P_COORDINATOR, name: 'riverbend' }];

vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined, allProjects: mockAllProjects }),
  useEffectiveProjectId: () => undefined,
}));

vi.mock('../../api', () => ({
  api: {
    tasks: { create: vi.fn(), update: vi.fn() },
    attachments: { upload: vi.fn(), list: vi.fn(), blob: vi.fn(), remove: vi.fn() },
  },
}));

// The downscale is its own tested unit; here it must not touch the canvas.
vi.mock('./downscale', () => ({ downscaleImage: vi.fn(async (f: File) => f) }));

import { api } from '../../api';
import { PunchForm } from './PunchForm';

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
          <PunchForm pageProjectId={P_COORDINATOR} onFiled={onFiled} onCancel={() => {}} {...props} />
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
const addClauseBtn = () =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '+ Add done-when') as HTMLButtonElement;

/** React listens to the native input event via its tracked-value setter. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.tasks.create.mockResolvedValue({ id: NEW_ID, project_id: P_COORDINATOR });
  mockApi.tasks.update.mockResolvedValue({ id: NEW_ID, stage: 'ready' });
  mockApi.attachments.upload.mockResolvedValue({ id: 'att-1', kind: 'before' });
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => 'blob:x');
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('PunchForm — Ready submit gating on the structured doneWhen contract', () => {
  it('disabled with no goal / no clause text', () => {
    mount();
    expect(submitBtn().disabled).toBe(true);
    act(() => type(goal(), 'The save button does nothing'));
    expect(submitBtn().disabled).toBe(true); // clause text still empty
  });

  it('a clause with owner UNSET keeps Ready disabled and names "owner" inline; choosing one enables it', () => {
    mount();
    act(() => type(goal(), 'Goal'));
    act(() => type(clauseText(1), 'Clicking Save shows a toast and the row updates'));
    // Owner not chosen yet — Ready stays disabled, the row names what is missing.
    expect(submitBtn().disabled).toBe(true);
    expect(container.textContent).toContain('Choose lane or human');
    expect(ownerGroup(1).getAttribute('aria-invalid')).toBe('true');

    act(() => ownerButton(1, 'Human').click());
    expect(submitBtn().disabled).toBe(false);
  });

  it('a LANE clause with empty proof keeps Ready disabled and names "proof" inline; filling it enables it', () => {
    mount();
    act(() => type(goal(), 'Goal'));
    act(() => type(clauseText(1), 'Save works'));
    act(() => ownerButton(1, 'Lane').click());
    expect(submitBtn().disabled).toBe(true);
    expect(clauseProof(1)).not.toBeNull(); // proof field appears only for a lane clause
    expect(container.textContent).toContain('Proof is required for a lane clause');

    act(() => type(clauseProof(1)!, 'Punch.test.tsx'));
    expect(submitBtn().disabled).toBe(false);
  });

  it('a HUMAN clause never shows a proof field and needs none to enable Ready', () => {
    mount();
    act(() => type(goal(), 'Goal'));
    act(() => type(clauseText(1), 'Someone eyeballs it'));
    act(() => ownerButton(1, 'Human').click());
    expect(clauseProof(1)).toBeNull();
    expect(submitBtn().disabled).toBe(false);
  });

  it('an untouched blank row shows no inline errors (only a STARTED row does)', () => {
    mount();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('adding a second row requires it complete too before Ready enables', () => {
    mount();
    act(() => type(goal(), 'Goal'));
    act(() => type(clauseText(1), 'First clause'));
    act(() => ownerButton(1, 'Human').click());
    expect(submitBtn().disabled).toBe(false);

    act(() => addClauseBtn().click());
    expect(submitBtn().disabled).toBe(true); // new blank row is incomplete
    act(() => type(clauseText(2), 'Second clause'));
    act(() => ownerButton(2, 'Lane').click());
    expect(submitBtn().disabled).toBe(true);
    act(() => type(clauseProof(2)!, 'src/thing.ts'));
    expect(submitBtn().disabled).toBe(false);
  });

  it('renders the fields in the brief order', () => {
    mount();
    const labels = Array.from(container.querySelectorAll('label'))
      .map((l) => l.textContent?.replace('*', '').trim())
      .filter((t): t is string => Boolean(t) && t !== 'Done when 1' && t !== 'Owner 1');
    expect(labels).toEqual(['Goal', 'Done when', 'Where', 'Proof', 'Photo', 'Touches', 'Dependencies', 'Notes', 'Kind']);
    expect(goal().placeholder).toBe("What's wrong or what should change — one sentence");
    // Proof defaults to Browser.
    const checked = container.querySelector('[aria-label="Proof"] [aria-checked="true"]');
    expect(checked?.textContent).toBe('Browser');
  });
});

describe('PunchForm — the submit flow', () => {
  function fillOneCompleteClause() {
    act(() => type(goal(), 'Save button dead'));
    act(() => type(clauseText(1), 'Save works'));
    act(() => ownerButton(1, 'Lane').click());
    act(() => type(clauseProof(1)!, 'Punch.test.tsx'));
  }

  it('create(draft) → upload(before) per photo → update(ready) → onFiled(id, ready)', async () => {
    mount();
    fillOneCompleteClause();
    const file = new File([new Uint8Array(4)], 'shot.jpg', { type: 'image/jpeg' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelectorAll('img').length).toBe(1); // preview

    act(() => {
      submitBtn().click();
    });
    await settle();

    expect(mockApi.tasks.create).toHaveBeenCalledTimes(1);
    const [payload, config] = mockApi.tasks.create.mock.calls[0];
    expect(payload).toEqual({
      title: 'Save button dead',
      description: undefined,
      type: 'bug',
      priority: 'medium',
      project_id: P_COORDINATOR,
      stage: 'draft',
      punch: {
        doneWhen: [{ text: 'Save works', owner: 'lane', proof: 'Punch.test.tsx' }],
        proofKind: 'browser',
        source: 'form',
      },
    });
    // `metadata.punch` is NEVER the channel this form writes.
    expect(payload.metadata).toBeUndefined();
    // The write is SCOPED to the form's project (X-Project-ID agrees with the body).
    expect(config?.headers?.['X-Project-ID']).toBe(P_COORDINATOR);

    expect(mockApi.attachments.upload).toHaveBeenCalledTimes(1);
    expect(mockApi.attachments.upload.mock.calls[0].slice(0, 3)).toEqual([NEW_ID, file, 'before']);

    expect(mockApi.tasks.update).toHaveBeenCalledWith(NEW_ID, { stage: 'ready' });
    expect(onFiled).toHaveBeenCalledWith(NEW_ID, 'ready');

    // Order: create before upload before ready.
    const order = [
      mockApi.tasks.create.mock.invocationCallOrder[0],
      mockApi.attachments.upload.mock.invocationCallOrder[0],
      mockApi.tasks.update.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('touches and dependencies ride the create payload — touches under `punch`, dependencies at the top level', async () => {
    mount();
    fillOneCompleteClause();
    const touchesBox = container.querySelector('textarea[aria-label="Touches"]') as HTMLTextAreaElement;
    const depsBox = container.querySelector('textarea[aria-label="Dependencies"]') as HTMLTextAreaElement;
    act(() => type(touchesBox, 'src/a.ts, src/b.ts\nsrc/c.ts'));
    act(() => type(depsBox, 'deadbeef, 11112222-3333-4444-8888-999999999999'));

    act(() => submitBtn().click());
    await settle();

    const [payload] = mockApi.tasks.create.mock.calls[0];
    expect(payload.punch.touches).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(payload.dependencies).toEqual(['deadbeef', '11112222-3333-4444-8888-999999999999']);
  });

  it('blank touches/dependencies are OMITTED, never sent as empty arrays', async () => {
    mount();
    fillOneCompleteClause();
    act(() => submitBtn().click());
    await settle();

    const [payload] = mockApi.tasks.create.mock.calls[0];
    expect(payload.punch.touches).toBeUndefined();
    expect(payload.dependencies).toBeUndefined();
  });

  it('PUNCH_INCOMPLETE on ready → the server message is shown VERBATIM, punch kept as draft', async () => {
    mockApi.tasks.update.mockRejectedValue({
      message: "task_update: refusing to set stage='ready' — missing: doneWhen[0].proof. NOTHING WAS WRITTEN. [PUNCH_INCOMPLETE]",
      code: 'PUNCH_INCOMPLETE',
      status: 400,
      details: { code: 'PUNCH_INCOMPLETE', missing: ['doneWhen[0].proof'] },
    });
    mount();
    fillOneCompleteClause();
    act(() => submitBtn().click());
    await settle();

    expect(mockApi.tasks.create).toHaveBeenCalledTimes(1);
    expect(onFiled).toHaveBeenCalledWith(NEW_ID, 'draft');
    expect(container.textContent).toContain(
      "task_update: refusing to set stage='ready' — missing: doneWhen[0].proof. NOTHING WAS WRITTEN. [PUNCH_INCOMPLETE]",
    );
  });

  it('a failed CREATE shows the server message verbatim and files nothing', async () => {
    mockApi.tasks.create.mockRejectedValue({ message: 'project not writable', status: 403 });
    mount();
    fillOneCompleteClause();
    act(() => submitBtn().click());
    await settle();
    expect(onFiled).not.toHaveBeenCalled();
    expect(mockApi.tasks.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain('project not writable');
    expect(submitBtn().disabled).toBe(false); // can retry
  });
});

describe('PunchForm — loading an existing punch (an earlier task item 6)', () => {
  it('a LEGACY STRING doneWhen loads as ONE row with owner unset and Ready disabled', () => {
    mount({ initialPunch: { doneWhen: 'the button works again', proofKind: 'browser' } });
    expect(clauseText(1).value).toBe('the button works again');
    expect(clauseText(2)).toBeNull(); // exactly one row
    expect(ownerGroup(1).querySelector('[aria-checked="true"]')).toBeNull(); // owner unset
    act(() => type(goal(), 'Goal'));
    expect(submitBtn().disabled).toBe(true); // forced to classify before Ready
  });

  it('a structured doneWhen loads one row per clause, already satisfying Ready', () => {
    mount({
      initialPunch: {
        doneWhen: [
          { text: 'clause one', owner: 'human' },
          { text: 'clause two', owner: 'lane', proof: 'src/x.ts' },
        ],
        proofKind: 'test',
      },
    });
    expect(clauseText(1).value).toBe('clause one');
    expect(clauseText(2).value).toBe('clause two');
    act(() => type(goal(), 'Goal'));
    expect(submitBtn().disabled).toBe(false);
  });
});
