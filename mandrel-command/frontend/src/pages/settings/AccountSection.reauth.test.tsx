/**
 * Batch 4 merge fold-in (the coordinator) — the CROSS-LANE half of an earlier task.
 *
 * Lane 9 made `PUT /api/users/profile` require `currentPassword` whenever an identity
 * field actually changes, answering 401 `code: 'REAUTH_REQUIRED'` without it. That is
 * the right fix, and on its own it BREAKS the Settings form: the caller lives in the
 * frontend, outside lane 9's file list, and sent no password at all.
 *
 * No unit test on either side could see that. The backend's tests prove the refusal;
 * the frontend's prove the form submits. Both stay green while the real screen 401s —
 * "green alone, RED merged", the exact failure the batch pattern warns about.
 *
 * So this guard spans the seam: it renders the REAL AccountSection, drives the REAL
 * two-step save a user performs, and asserts on the BODY that reaches the api layer.
 * It does not test that a password field exists; it tests that the credential arrives
 * with the change it authorises.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api', () => ({
  api: {
    users: {
      updateProfile: vi.fn(),
      changePassword: vi.fn(),
      revokeSessions: vi.fn(),
    },
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({
    user: { id: 'u-1', username: 'operator', email: 'operator@example.com' },
  }),
}));

/**
 * A self-labelling fixture value. It authenticates nothing: `../../api` is mocked in this
 * file, so no request leaves the test. It reads as what it is on sight — a password-SHAPED
 * literal in a TS object is exactly the pattern a secret scanner should flag, and the
 * scanner cannot know it is inert, so the value should say so rather than look plausible.
 * (An earlier 'hunter2' here tripped GitGuardian on commit 7062f00 — a correct catch of a
 * harmless string. Our own .gitleaks.toml deliberately does NOT match lower-case object
 * keys: a variant that did produced 375 findings on this repo and was measured unusable.)
 */
const FIXTURE_PASSWORD = 'not-a-real-password-test-fixture';

import { AccountSection } from './AccountSection';
import { api } from '../../api';

const mockUpdate = (api as unknown as {
  users: { updateProfile: ReturnType<typeof vi.fn> };
}).users.updateProfile;

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AccountSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

// The Modal portals out of the section's container, so scope DOM reads to the document.
function field(label: string): HTMLInputElement {
  const el = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!el) throw new Error(`no input labelled "${label}"`);
  return el;
}

/** React owns the value setter; assigning .value directly does not notify it. */
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(formId: string) {
  const form = document.body.querySelector<HTMLFormElement>(`#${formId}`);
  if (!form) throw new Error(`no form #${formId}`);
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  // React Query settles the mutation on a MACROtask, not a microtask — traced, after
  // two Promise.resolve() flushes proved insufficient and the DOM read stale. A real
  // timer tick is what makes the settled state observable.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({ id: 'u-1', username: 'coordinator', email: 'operator@example.com' });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('AccountSection re-auth — the client half of 30326784', () => {
  it('sends currentPassword with a changed username', async () => {
    await mount();
    await type(field('Username'), 'coordinator');
    await submit('profile-form');

    // THE ASSERTION THAT MATTERS: the first step must not have called the API at all.
    // If it did, it sent no password and the user gets a 401 they cannot act on.
    expect(mockUpdate).not.toHaveBeenCalled();

    await type(field('Current password'), FIXTURE_PASSWORD);
    await submit('confirm-profile-form');

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({
      username: 'coordinator',
      currentPassword: FIXTURE_PASSWORD,
    });
  });

  it('sends currentPassword with a changed email', async () => {
    await mount();
    await type(field('Email'), 'new@example.com');
    await submit('profile-form');
    await type(field('Current password'), FIXTURE_PASSWORD);
    await submit('confirm-profile-form');

    expect(mockUpdate).toHaveBeenCalledWith({
      email: 'new@example.com',
      currentPassword: FIXTURE_PASSWORD,
    });
  });

  it('never sends a body without currentPassword when something changed', async () => {
    await mount();
    await type(field('Username'), 'coordinator');
    await type(field('Email'), 'new@example.com');
    await submit('profile-form');
    await type(field('Current password'), FIXTURE_PASSWORD);
    await submit('confirm-profile-form');

    for (const call of mockUpdate.mock.calls) {
      expect(call[0].currentPassword).toBeTruthy();
    }
  });

  it('does not fire at all when nothing is dirty — a no-op needs no password', async () => {
    await mount();
    await submit('profile-form');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(document.body.querySelector('#confirm-profile-form')).toBeNull();
  });

  it('surfaces the server rejection in the confirm step rather than failing silently', async () => {
    mockUpdate.mockRejectedValue({
      message: 'Your current password is required to change your username or email',
      code: 'REAUTH_REQUIRED',
      status: 401,
    });
    await mount();
    await type(field('Username'), 'coordinator');
    await submit('profile-form');
    await type(field('Current password'), 'wrong');
    await submit('confirm-profile-form');

    expect(document.body.textContent).toContain('current password is required');
    // Still open, so the user can retry — a closed modal would strand them.
    expect(document.body.querySelector('#confirm-profile-form')).not.toBeNull();
  });
});
