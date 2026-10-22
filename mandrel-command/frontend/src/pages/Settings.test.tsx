/**
 * Settings render tests (P4 control-panel rebuild) — mirrors the Dashboard/Decisions test
 * style: createRoot + async act into jsdom, behind QueryClientProvider + MemoryRouter, with
 * the UNIFIED `api` client + the four app contexts mocked. Proves:
 *   • the default Account section renders the profile seeded from the auth user;
 *   • the section rail switches panels;
 *   • the LIVE Appearance theme control applies + PERSISTS through api.users.updatePreferences;
 *   • the honest data-gap sections (Actors & identity / Notifications / API & tokens) render
 *     their gap note and disabled affordances (never faked controls);
 *   • the Danger zone targets the active project.
 * Structural wiring (no antd, unified client, no hex, gap sections don't mutate) is asserted
 * in Settings.wiring.test.ts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    users: {
      updateProfile: vi.fn(),
      changePassword: vi.fn(),
      updatePreferences: vi.fn(),
      revokeSessions: vi.fn(),
    },
    projects: { setPrimary: vi.fn(), clearPrimary: vi.fn(), remove: vi.fn() },
  },
}));

const setThemeMode = vi.fn();
const updateSettings = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  useAuthContext: () => ({ user: { username: 'operator', email: 'operator@example.com' } }),
}));
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ themeMode: 'dark', setThemeMode }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ defaultProject: 'riverbend', updateSettings }),
}));
vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    currentProject: { id: 'p-coordinator', name: 'riverbend' },
    allProjects: [
      { id: 'p-coordinator', name: 'riverbend' },
      { id: 'p-daisy', name: 'daisy' },
    ],
    isAllProjects: false,
    setCurrentProject: vi.fn(),
    refreshProjects: vi.fn().mockResolvedValue([]),
  }),
  // DangerZoneSection resolves its delete target via useEffectiveProjectId; not in
  // "All Projects" here, so it follows the concrete active project.
  useEffectiveProjectId: () => 'p-coordinator',
}));

import Settings from './Settings';
import { api } from '../api';

const mockApi = api as unknown as {
  users: {
    updateProfile: ReturnType<typeof vi.fn>;
    changePassword: ReturnType<typeof vi.fn>;
    updatePreferences: ReturnType<typeof vi.fn>;
    revokeSessions: ReturnType<typeof vi.fn>;
  };
  projects: {
    setPrimary: ReturnType<typeof vi.fn>;
    clearPrimary: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
};

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
          <Settings />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Click the first <button> whose visible text matches (trimmed, case-insensitive). */
async function clickButton(text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().toLowerCase().includes(text.toLowerCase()),
  );
  if (!btn) throw new Error(`button "${text}" not found`);
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.users.updatePreferences.mockResolvedValue({});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Settings — shell + Account (default section)', () => {
  it('renders the page heading and the section rail', async () => {
    await mount();
    expect(container.textContent).toContain('Settings');
    // Rail entries from config.
    expect(container.textContent).toContain('Account');
    expect(container.textContent).toContain('Actors & identity');
    expect(container.textContent).toContain('Danger zone');
  });

  it('seeds the profile form from the authenticated user', async () => {
    await mount();
    const inputs = Array.from(container.querySelectorAll('input')) as HTMLInputElement[];
    const values = inputs.map((i) => i.value);
    expect(values).toContain('operator');
    expect(values).toContain('operator@example.com');
  });
});

describe('Settings — Appearance is LIVE (applies + persists)', () => {
  it('choosing Light applies the theme and persists via api.users.updatePreferences', async () => {
    await mount();
    await clickButton('Appearance'); // rail → Appearance section
    await clickButton('Light'); // segmented control
    expect(setThemeMode).toHaveBeenCalledWith('light');
    expect(mockApi.users.updatePreferences).toHaveBeenCalledWith({ theme: 'light' });
  });
});

describe('Settings — honest data-gap sections name the gap (no faked controls)', () => {
  it('Notifications shows the gap note with disabled checkboxes', async () => {
    await mount();
    await clickButton('Notifications');
    expect(container.textContent).toContain('no Command backend endpoint');
    const checks = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.disabled)).toBe(true);
  });

  it('Actors & identity shows the runtime-managed reference note', async () => {
    await mount();
    await clickButton('Actors & identity');
    expect(container.textContent).toContain('managed by the Runtime');
  });

  it('API & tokens disables the rotate control and names the gap', async () => {
    await mount();
    await clickButton('API & tokens');
    expect(container.textContent).toContain('no Command backend endpoint');
    const rotate = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Rotate'),
    ) as HTMLButtonElement | undefined;
    expect(rotate?.disabled).toBe(true);
  });
});

describe('Settings — Danger zone targets the active project', () => {
  it('shows a delete affordance for the current project', async () => {
    await mount();
    await clickButton('Danger zone');
    expect(container.textContent).toContain('Delete this project');
    expect(container.textContent).toContain('riverbend');
  });
});
