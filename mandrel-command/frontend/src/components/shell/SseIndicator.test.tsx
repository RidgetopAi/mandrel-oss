/**
 * SseIndicator — the topbar must not say "Live" while the app cannot reach the server,
 * and the disconnected state must not collapse to an unlabelled dot.
 *
 * The two measured causes this file guards:
 *   1. the indicator keyed off SSE liveness ONLY, so a failing `/api/*` under a healthy
 *      stream still showed a green "Live";
 *   2. below 600px the label was hidden outright, and `title=` does not exist on touch,
 *      so the operator's phone showed a coloured dot and nothing else.
 *
 * SPECIFICITY, not just sensitivity: a live server ANSWERING 500 or 404 is a page-level
 * error and must NOT paint the topbar red, or the indicator becomes noise and gets
 * ignored — which is the same trust failure in the other direction. That case is
 * asserted below, driving a real QueryClient cache rather than the component's props.
 *
 * The mobile half cannot be executed in jsdom (`css: false` in vite.config — CSS modules
 * are not compiled for tests), so it is asserted against the stylesheet SOURCE here and
 * was additionally verified in a real Chromium at 375×812 (see the task report). The
 * source assertion is the regression guard; the browser run is the proof.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const sse = vi.hoisted(() => ({ isConnected: true, isSupported: true }));
vi.mock('../../contexts/SseContext', () => ({
  useSseContext: () => ({ isConnected: sse.isConnected, isSupported: sse.isSupported }),
}));

import { SseIndicator, indicatorState, isUnreachableError } from './SseIndicator';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

/**
 * Mount the indicator over a REAL query cache. `seedError` is planted the way the shared
 * axios interceptor rejects (`{ message, code, status, details }`), so this drives the
 * shape the product actually sees rather than a shape invented here.
 */
async function mount(seedError?: unknown) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  if (seedError !== undefined) {
    await client
      .fetchQuery({ queryKey: ['probe'], queryFn: () => Promise.reject(seedError) })
      .catch(() => undefined);
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <SseIndicator />
      </QueryClientProvider>,
    );
  });
}

function indicator(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="status"]');
  if (!el) throw new Error('indicator did not render');
  return el;
}

beforeEach(() => {
  sse.isConnected = true;
  sse.isSupported = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('isUnreachableError', () => {
  it('is true only for a rejection that never got an HTTP response (status 0)', () => {
    expect(isUnreachableError({ message: 'Network Error', status: 0 })).toBe(true);
    // A live server answering is NOT unreachable — these are the false-positive population.
    expect(isUnreachableError({ message: 'Not found', status: 404 })).toBe(false);
    expect(isUnreachableError({ message: 'Boom', status: 500 })).toBe(false);
    // The other shape that reaches the cache: a real Error from unwrapData, no status.
    expect(isUnreachableError(new Error('success:false'))).toBe(false);
    // The absent population.
    expect(isUnreachableError(undefined)).toBe(false);
    expect(isUnreachableError(null)).toBe(false);
    expect(isUnreachableError('offline')).toBe(false);
  });
});

describe('indicatorState precedence', () => {
  it('unreachable reads OUTRANK a healthy SSE stream (the reported bug)', () => {
    const s = indicatorState({ apiUnreachable: true, isConnected: true, isSupported: true });
    expect(s.label).toBe('Offline');
    expect(s.degraded).toBe(true);
  });

  it('a dropped stream with working reads says "Not live", not "Offline"', () => {
    const s = indicatorState({ apiUnreachable: false, isConnected: false, isSupported: true });
    expect(s.label).toBe('Not live');
    expect(s.degraded).toBe(true);
  });

  it('unsupported realtime is degraded too, so its label survives on mobile', () => {
    const s = indicatorState({ apiUnreachable: false, isConnected: false, isSupported: false });
    expect(s.label).toBe('Polling');
    expect(s.degraded).toBe(true);
  });

  it('only the fully healthy state is NOT degraded', () => {
    const s = indicatorState({ apiUnreachable: false, isConnected: true, isSupported: true });
    expect(s.label).toBe('Live');
    expect(s.degraded).toBe(false);
  });
});

describe('SseIndicator over a real query cache', () => {
  it('says Live and hides nothing when everything is healthy', async () => {
    await mount();
    expect(indicator().textContent).toBe('Live');
    expect(indicator().getAttribute('data-degraded')).toBe('false');
  });

  it('goes Offline + degraded when a read got NO answer from the server, even with SSE up', async () => {
    sse.isConnected = true;
    await mount({ message: 'Network Error', code: undefined, status: 0, details: undefined });
    expect(indicator().textContent).toBe('Offline');
    expect(indicator().getAttribute('data-degraded')).toBe('true');
    expect(indicator().getAttribute('title')).toContain("Can't reach the server");
  });

  it('does NOT go Offline for a server that answered 500 (specificity)', async () => {
    await mount({ message: 'Internal error', status: 500 });
    expect(indicator().textContent).toBe('Live');
    expect(indicator().getAttribute('data-degraded')).toBe('false');
  });

  it('reacts to a read failing AFTER mount, without a remount', async () => {
    await mount();
    expect(indicator().textContent).toBe('Live');
    await act(async () => {
      await client
        .fetchQuery({
          queryKey: ['later'],
          queryFn: () => Promise.reject({ message: 'Network Error', status: 0 }),
        })
        .catch(() => undefined);
    });
    expect(indicator().textContent).toBe('Offline');
  });

  it('announces itself to assistive tech (role=status, polite)', async () => {
    await mount();
    expect(indicator().getAttribute('aria-live')).toBe('polite');
  });
});

describe('Topbar.module.css — the mobile breakpoint', () => {
  const cssPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'Topbar.module.css',
  );
  const css = readFileSync(cssPath, 'utf8');
  /** The body of the narrow-topbar media block. */
  const mobileBlock = (() => {
    const start = css.indexOf('@media (max-width: 600px)');
    expect(start, 'the narrow-topbar media query must exist').toBeGreaterThan(-1);
    return css.slice(start);
  })();

  it('hides the label on narrow screens ONLY while the state is healthy', () => {
    expect(mobileBlock).toContain(".sse[data-degraded='false'] .sseLabel");
    // The exact rule that produced the bare dot: an unconditional hide. If it comes
    // back, "Offline" disappears on the device the operator actually uses.
    expect(mobileBlock).not.toMatch(/(^|\n)\s*\.sseLabel\s*\{/);
  });

  it('gives the degraded state a visible chip, not just a coloured dot', () => {
    expect(css).toContain(".sse[data-degraded='true']");
  });
});
