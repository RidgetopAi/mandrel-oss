/**
 * Feedback render + submit tests (an earlier task rebuild) — same harness as
 * Settings.test.tsx / Dashboard.test.tsx: createRoot + async act into jsdom, behind
 * QueryClientProvider + MemoryRouter, with the UNIFIED `api` client mocked at the module
 * boundary. Proves the things a reviewer actually cares about:
 *   • the page renders without antd (heading, both selects, the message field, the button);
 *   • a happy-path submit calls api.feedback.submit with the EXACT payload the backend
 *     route validates ({type, severity, message, page}), and clears the form;
 *   • VALIDATION: an empty / whitespace-only message never reaches the network;
 *   • VALIDATION: over-length is refused client-side (the server's cap, mirrored);
 *   • ERROR PATH: a rejected submit renders the SERVER's message (via apiErrorMessage)
 *     and does NOT clear what the user typed;
 *   • the auto-captured `page` is the screen the user CAME FROM, never '/feedback' —
 *     the defect this rebuild fixes — and is OMITTED when there is nothing to report.
 * Structural wiring (no antd, unified client, tokens, config) is in Feedback.wiring.test.ts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    feedback: {
      submit: vi.fn(),
      list: vi.fn(),
    },
  },
}));

import Feedback from './Feedback';
import { FEEDBACK_CONFIG } from './feedback/config';
import { api } from '../api';
import { clearLastVisitedPath, recordVisitedPath } from '../utils/lastVisitedPath';

const mockApi = api as unknown as {
  feedback: { submit: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
};

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Feedback />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;

/** Type into the message textarea the way React's onChange sees it. */
async function typeMessage(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Submit the form (the same path the button's type="submit" takes). */
async function submitForm() {
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** Open a Select by its aria-label and choose the option with the given label. */
async function chooseOption(selectLabel: string, optionLabel: string) {
  const trigger = container.querySelector(
    `button[aria-haspopup="listbox"][aria-label="${selectLabel}"]`,
  ) as HTMLButtonElement;
  if (!trigger) throw new Error(`select "${selectLabel}" not found`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const option = Array.from(container.querySelectorAll('[role="option"]')).find(
    (li) => (li.textContent ?? '').trim() === optionLabel,
  );
  if (!option) throw new Error(`option "${optionLabel}" not found in "${selectLabel}"`);
  await act(async () => {
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLastVisitedPath();
  sessionStorage.clear();
  mockApi.feedback.submit.mockResolvedValue({ id: 'fb-1' });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  clearLastVisitedPath();
  sessionStorage.clear();
});

describe('Feedback — renders on the current design system', () => {
  it('renders the heading, both selects, the message field and the submit button', async () => {
    await mount();
    expect(container.textContent).toContain('Feedback');
    expect(
      container.querySelector('button[aria-haspopup="listbox"][aria-label="Type"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-haspopup="listbox"][aria-label="Severity"]'),
    ).not.toBeNull();
    expect(textarea()).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('defaults to bug / medium (the table defaults)', async () => {
    await mount();
    const type = container.querySelector('button[aria-label="Type"]');
    const severity = container.querySelector('button[aria-label="Severity"]');
    expect(type?.textContent).toContain('Bug');
    expect(severity?.textContent).toContain('Medium');
  });
});

describe('Feedback — submit round-trip through the unified client', () => {
  it('sends exactly {type, severity, message, page} and clears the form', async () => {
    recordVisitedPath('/sessions');
    await mount();
    await chooseOption('Type', 'Idea');
    await chooseOption('Severity', 'High');
    await typeMessage('  The session list paginates twice.  ');
    await submitForm();

    expect(mockApi.feedback.submit).toHaveBeenCalledTimes(1);
    expect(mockApi.feedback.submit).toHaveBeenCalledWith({
      type: 'idea',
      severity: 'high',
      message: 'The session list paginates twice.',
      page: '/sessions',
    });
    // Success is confirmed inline and the form resets to its defaults.
    expect(container.textContent).toContain('Thanks — got it.');
    expect(textarea().value).toBe('');
    expect(container.querySelector('button[aria-label="Type"]')?.textContent).toContain('Bug');
  });
});

describe('Feedback — validation keeps a doomed request off the wire', () => {
  it('refuses an empty message', async () => {
    await mount();
    await submitForm();
    expect(mockApi.feedback.submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Please write a message before sending.');
  });

  it('refuses a whitespace-only message', async () => {
    await mount();
    await typeMessage('     \n\t  ');
    await submitForm();
    expect(mockApi.feedback.submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Please write a message before sending.');
  });

  it('refuses a message longer than the server cap', async () => {
    await mount();
    // maxLength on the control is a UI courtesy; drive the state past it directly to
    // prove the SUBMIT path itself refuses (a paste/autofill can bypass maxLength).
    await typeMessage('x'.repeat(FEEDBACK_CONFIG.maxMessageLength + 1));
    await submitForm();
    expect(mockApi.feedback.submit).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      `${FEEDBACK_CONFIG.maxMessageLength} characters or fewer`,
    );
  });

  it('clears the validation error as soon as the user types', async () => {
    await mount();
    await submitForm();
    expect(container.textContent).toContain('Please write a message before sending.');
    await typeMessage('now there is a message');
    expect(container.textContent).not.toContain('Please write a message before sending.');
  });
});

describe('Feedback — error path surfaces the SERVER message and keeps the draft', () => {
  it('renders the rejection message and does not clear what was typed', async () => {
    const serverSentence = `Message must be ${FEEDBACK_CONFIG.maxMessageLength} characters or fewer`;
    mockApi.feedback.submit.mockRejectedValue({ message: serverSentence });
    await mount();
    await typeMessage('something broke');
    await submitForm();

    expect(container.textContent).toContain("Couldn't send that");
    expect(container.textContent).toContain(serverSentence);
    expect(textarea().value).toBe('something broke');
  });

  it('falls back to a readable sentence when the rejection carries no message', async () => {
    mockApi.feedback.submit.mockRejectedValue({});
    await mount();
    await typeMessage('something broke');
    await submitForm();
    expect(container.textContent).toContain('Failed to submit feedback. Please try again.');
  });
});

describe('Feedback — the auto-captured page is the screen the user CAME FROM', () => {
  it('reports the previous route, never /feedback (the defect this rebuild fixes)', async () => {
    recordVisitedPath('/analytics');
    // The user then navigated to the feedback screen itself — which must be ignored.
    recordVisitedPath('/feedback');
    await mount();

    expect(container.textContent).toContain('/analytics');
    await typeMessage('the chart is empty');
    await submitForm();
    const payload = mockApi.feedback.submit.mock.calls[0][0];
    expect(payload.page).toBe('/analytics');
    expect(payload.page).not.toBe('/feedback');
  });

  it('omits page entirely (and says so) when nothing was captured', async () => {
    await mount();
    expect(container.textContent).toContain('No screen captured');
    await typeMessage('deep-linked straight here');
    await submitForm();
    expect(mockApi.feedback.submit).toHaveBeenCalledWith({
      type: 'bug',
      severity: 'medium',
      message: 'deep-linked straight here',
    });
  });
});

describe('Feedback — no unscoped feedback list is rendered', () => {
  it('never calls api.feedback.list (GET /api/feedback is unscoped on the server)', async () => {
    await mount();
    await typeMessage('anything');
    await submitForm();
    expect(mockApi.feedback.list).not.toHaveBeenCalled();
  });
});
