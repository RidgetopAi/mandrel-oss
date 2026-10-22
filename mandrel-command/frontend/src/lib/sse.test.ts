import { QueryClient } from '@tanstack/react-query';
import { startSse, sseReconnectConfig } from './sse';
import { AidisDbEvent } from '../types/events';
import { sseConfig } from '../config/sseConfig';

// Mock EventSource
class MockEventSource {
  url: string;
  readyState: number = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  listeners: Map<string, ((event: MessageEvent) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.triggerOpen(), 0);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  close() {
    this.readyState = 2;
  }

  triggerOpen() {
    this.readyState = 1;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  triggerMessage(type: string, data: any) {
    const listeners = this.listeners.get(type);
    if (listeners) {
      const event = { data: JSON.stringify(data) } as MessageEvent;
      listeners.forEach(listener => listener(event));
    }
  }

  triggerError() {
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

describe('SSE Client', () => {
  let queryClient: QueryClient;
  let mockEventSource: MockEventSource;
  let originalEventSource: any;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let fetchMock: jest.Mock;
  let ticketCounter: number;

  /**
   * `startSse` is now asynchronous underneath: it mints a connect ticket over fetch BEFORE
   * it opens the EventSource, because the session JWT may no longer travel in the URL
   *. Draining the microtask queue is what makes the connection observable
   * to a synchronous assertion — and it works under fake timers, which the coalescing
   * tests need.
   */
  const startConnected = async (opts: Parameters<typeof startSse>[0]) => {
    const handle = startSse(opts);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return handle;
  };

  beforeEach(() => {
    // POST /api/events/ticket — the mint the ticketed connect path depends on. Every
    // call hands back a DISTINCT ticket, which is what lets the reconnect test prove a
    // fresh one was minted rather than a spent one replayed.
    ticketCounter = 0;
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { ticket: `ticket-${++ticketCounter}` } }),
    }));
    (globalThis as any).fetch = fetchMock;

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    // Mock EventSource
    originalEventSource = (window as any).EventSource;
    (window as any).EventSource = jest.fn((url: string) => {
      mockEventSource = new MockEventSource(url);
      return mockEventSource;
    });

    // Spy on console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    // Mock window.dispatchEvent
    jest.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
    // Coalescing state is per-connection (lives inside startSse), so it can't
    // leak between tests — just drop any fake timers a test enabled.
    jest.useRealTimers();
    (window as any).EventSource = originalEventSource;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('startSse()', () => {
    it('should create EventSource with correct URL and params', async () => {
      // Use a real UUID — a non-UUID projectId is intentionally dropped (see the
      // self-heal validation tests below).
      const validProjectId = 'c875b2af-9020-41b7-9595-d70221603464';
      await startConnected({
        token: 'test-token',
        projectId: validProjectId,
        entities: ['tasks', 'contexts'],
        queryClient,
      });

      expect((window as any).EventSource).toHaveBeenCalledWith(
        expect.stringContaining('/api/events?')
      );
      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      // The credential in the URL is a TICKET now, never the session JWT.
      expect(url).toContain('ticket=ticket-1');
      expect(url).not.toContain('test-token');
      expect(url).toContain(`projectId=${validProjectId}`);
      expect(url).toContain('entities=tasks%2Ccontexts');
    });

    it('does NOT attach a non-UUID projectId to the SSE URL (contoso self-heal)', async () => {
      // The exact corrupt id from the customer report. The backend SSE route
      // would 400 ("Invalid project ID format") and spam "SSE connection error";
      // we must open an unfiltered stream instead, never sending the bad id.
      await startConnected({
        token: 'test-token',
        projectId: 'session_voiceitt-bridge',
        entities: ['tasks'],
        queryClient,
      });

      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      // EventSource is still opened (stream works), but WITHOUT the bad filter.
      expect(url).toContain('/api/events?');
      expect(url).not.toContain('projectId');
      expect(url).not.toContain('session_voiceitt-bridge');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Dropping non-UUID projectId from SSE subscription:',
        'session_voiceitt-bridge'
      );
    });

    it('drops the UNASSIGNED sentinel projectId from the SSE URL', async () => {
      await startConnected({
        token: 'test-token',
        projectId: '00000000-0000-0000-0000-000000000000',
        queryClient,
      });
      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      expect(url).not.toContain('projectId');
    });

    it('should return unsupported flag when EventSource not available', async () => {
      delete (window as any).EventSource;

      const handle = startSse({
        token: 'test-token',
        queryClient,
      });

      expect(handle.unsupported).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith('SSE not supported by browser');
    });

    it('should call onConnect when connection opens', async () => {
      const onConnect = jest.fn();

      await startConnected({
        token: 'test-token',
        queryClient,
        onConnect,
      });

      // MockEventSource fires open on a macrotask, so wait one out.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(onConnect).toHaveBeenCalled();
    });

    it('should register listeners for all entity types', async () => {
      await startConnected({
        token: 'test-token',
        queryClient,
      });

      expect(mockEventSource.listeners.has('contexts')).toBe(true);
      expect(mockEventSource.listeners.has('tasks')).toBe(true);
      expect(mockEventSource.listeners.has('decisions')).toBe(true);
      expect(mockEventSource.listeners.has('projects')).toBe(true);
      expect(mockEventSource.listeners.has('sessions')).toBe(true);
      expect(mockEventSource.listeners.has('system')).toBe(true);
    });

    it('should handle task events and invalidate queries', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const taskEvent = {
        entity: 'tasks' as const,
        action: 'update' as const,
        id: 'task-123',
        at: new Date().toISOString(),
      } as AidisDbEvent;

      mockEventSource.triggerMessage('tasks', taskEvent);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboardStats'] });
    });

    it('should dispatch custom event for task updates', async () => {
      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const taskEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'insert',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      mockEventSource.triggerMessage('tasks', taskEvent);

      expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'aidis:task-update',
          detail: taskEvent,
        })
      );
    });

    it('should handle context events and invalidate queries', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const contextEvent: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        at: new Date().toISOString(),
      };

      mockEventSource.triggerMessage('contexts', contextEvent);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['contexts', 'list'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['contexts', 'stats'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboardStats'] });
    });

    it('should handle decision events', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const decisionEvent: AidisDbEvent = {
        entity: 'decisions',
        action: 'update',
        id: 'dec-123',
        at: new Date().toISOString(),
      };

      mockEventSource.triggerMessage('decisions', decisionEvent);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboardStats'] });
    });

    it('should handle project events', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const projectEvent: AidisDbEvent = {
        entity: 'projects',
        action: 'update',
        id: 'proj-123',
        at: new Date().toISOString(),
      };

      mockEventSource.triggerMessage('projects', projectEvent);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['currentProject'] });
    });

    it('should handle session events', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const sessionEvent: AidisDbEvent = {
        entity: 'sessions',
        action: 'update',
        id: 'sess-123',
        at: new Date().toISOString(),
      };

      mockEventSource.triggerMessage('sessions', sessionEvent);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    });

    it('should handle invalid JSON gracefully', async () => {
      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const listeners = mockEventSource.listeners.get('tasks')!;
      listeners[0]({ data: 'invalid-json{' } as MessageEvent);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to parse SSE event:',
        expect.any(Error)
      );
    });

    it('should call onError when connection error occurs', async () => {
      const onError = jest.fn();

      await startConnected({
        token: 'test-token',
        queryClient,
        onError,
      });

      mockEventSource.triggerError();

      expect(onError).toHaveBeenCalled();
    });

    it('should invalidate dashboardStats on error', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      mockEventSource.triggerError();

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboardStats'] });
    });
  });

  describe('stop()', () => {
    it('should close EventSource connection', async () => {
      const handle = await startConnected({
        token: 'test-token',
        queryClient,
      });

      handle.stop();

      expect(mockEventSource.readyState).toBe(2); // CLOSED
    });

    it('should call onDisconnect callback', async () => {
      const onDisconnect = jest.fn();

      const handle = await startConnected({
        token: 'test-token',
        queryClient,
        onDisconnect,
      });

      handle.stop();

      expect(onDisconnect).toHaveBeenCalled();
    });
  });

  describe('invalidation coalescing (a past incident single-flight — Contexts flashing fix)', () => {
    const contextsEvent = (i: number): AidisDbEvent => ({
      entity: 'contexts',
      action: 'insert',
      id: `ctx-${i}`,
      at: new Date().toISOString(),
    });

    it('collapses a burst of same-entity events to at most one invalidation per window', async () => {
      jest.useFakeTimers();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({ token: 'test-token', queryClient });

      // Count invalidations of the contexts LIST query specifically (the one the
      // page live-renders). Without coalescing this equals the event count.
      const contextsListInvalidations = () =>
        invalidateSpy.mock.calls.filter(
          (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ['contexts', 'list'] })
        ).length;

      // Fire 10 rapid contexts events inside a single window.
      for (let i = 0; i < 10; i++) {
        mockEventSource.triggerMessage('contexts', contextsEvent(i));
      }

      // Leading edge: exactly ONE invalidation for the whole burst — not 10.
      // (This assertion FAILS without the coalescer: it would be 10 → flashing.)
      expect(contextsListInvalidations()).toBe(1);

      // Closing the window flushes at most ONE trailing invalidation for the burst.
      jest.advanceTimersByTime(sseConfig.invalidationDebounceMs);
      expect(contextsListInvalidations()).toBe(2);

      // A subsequent quiet window closes with no further invalidations.
      jest.advanceTimersByTime(sseConfig.invalidationDebounceMs);
      expect(contextsListInvalidations()).toBe(2);
    });

    it('coalesces PER entity — a contexts burst does not starve a tasks event', async () => {
      jest.useFakeTimers();
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      await startConnected({ token: 'test-token', queryClient });

      for (let i = 0; i < 5; i++) {
        mockEventSource.triggerMessage('contexts', contextsEvent(i));
      }
      // A tasks event in the same instant must still invalidate immediately (its
      // own window is independent of the contexts window).
      mockEventSource.triggerMessage('tasks', {
        entity: 'tasks',
        action: 'update',
        id: 'task-1',
        at: new Date().toISOString(),
      } as AidisDbEvent);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
      const contextsListInvalidations = invalidateSpy.mock.calls.filter(
        (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ['contexts', 'list'] })
      ).length;
      expect(contextsListInvalidations).toBe(1); // burst of 5 → 1 leading
    });
  });

  describe('URL building', () => {
    it('should build URL without optional params', async () => {
      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      expect(url).toContain('ticket=ticket-1');
      expect(url).not.toContain('token=');
      expect(url).not.toContain('projectId');
      expect(url).not.toContain('entities');
    });

    it('should use absolute VITE_API_URL from env if available (trailing /api stripped)', async () => {
      vi.stubEnv('VITE_API_URL', 'http://example.com:8080/api'); // reserved-port-ok: URL fixture on example.com, nothing binds it

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      expect(url).toContain('http://example.com:8080/api/events'); // reserved-port-ok: URL fixture on example.com, nothing binds it
      expect(url).not.toContain('/api/api/');

      vi.unstubAllEnvs();
    });

    it('should use same-origin (relative) URL if env not set', async () => {
      vi.unstubAllEnvs();

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      // Empty base => relative URL rooted at /api, resolved against current origin.
      expect(url).toMatch(/^\/api\/events\?/);
      expect(url).not.toContain('http://localhost:5000'); // reserved-port-ok: asserts the URL does NOT carry prod's :5000 — names it, never binds it
    });

    it('should use same-origin (relative) URL when env is a relative path', async () => {
      vi.stubEnv('VITE_API_URL', '/api');

      await startConnected({
        token: 'test-token',
        queryClient,
      });

      const url = ((window as any).EventSource as jest.Mock).mock.calls[0][0];
      expect(url).toMatch(/^\/api\/events\?/);
      expect(url).not.toContain('http://localhost:5000'); // reserved-port-ok: asserts the URL does NOT carry prod's :5000 — names it, never binds it

      vi.unstubAllEnvs();
    });
  });

  /**
   * ── THE CREDENTIAL NEVER TOUCHES THE URL ────────────────────────────
   *
   * These are the FRONTEND half of the fix; the backend half lives in
   * `backend/src/__tests__/sseTicketAuth.test.ts`, which drives real HTTP and proves
   * `?token=` is refused. Neither is sufficient alone: this file proves the client stopped
   * SENDING the old shape, that file proves the server stopped ACCEPTING it, and the
   * combination is what makes "the two halves agree" a measured claim rather than a hope.
   */
  describe('the session JWT is out of the SSE URL', () => {
    it('the JWT is sent as an Authorization HEADER to the mint endpoint, and nowhere else', async () => {
      await startConnected({ token: 'super-secret-jwt', queryClient });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [mintUrl, mintInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(mintUrl).toContain('/api/events/ticket');
      expect(mintUrl).not.toContain('super-secret-jwt');
      expect(mintInit.method).toBe('POST');
      expect((mintInit.headers as Record<string, string>).Authorization).toBe(
        'Bearer super-secret-jwt'
      );
    });

    it('the JWT appears in NO EventSource URL — the exact string is absent', async () => {
      await startConnected({ token: 'super-secret-jwt', queryClient });

      const calls = ((window as any).EventSource as jest.Mock).mock.calls;
      expect(calls.length).toBe(1);
      for (const [url] of calls) {
        expect(url).not.toContain('super-secret-jwt');
        expect(url).not.toMatch(/[?&]token=/);
        expect(url).toMatch(/[?&]ticket=/);
      }
    });

    it('the ticket is redacted out of the console log line', async () => {
      await startConnected({ token: 'super-secret-jwt', queryClient });

      const logged = consoleLogSpy.mock.calls
        .map((args: unknown[]) => JSON.stringify(args))
        .join('\n');
      expect(logged).toContain('ticket=***');
      expect(logged).not.toContain('ticket-1');
      expect(logged).not.toContain('super-secret-jwt');
    });

    it('no EventSource is opened at all when the mint fails', async () => {
      fetchMock.mockImplementation(async () => ({ ok: false, status: 401, json: async () => ({}) }));

      const handle = await startConnected({ token: 'test-token', queryClient });

      expect((window as any).EventSource).not.toHaveBeenCalled();
      handle.stop();
    });

    it('stop() during an in-flight mint never opens a connection', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      fetchMock.mockImplementation(async () => {
        await gate;
        return { ok: true, status: 200, json: async () => ({ data: { ticket: 'late-ticket' } }) };
      });

      const handle = startSse({ token: 'test-token', queryClient });
      handle.stop();
      release();
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect((window as any).EventSource).not.toHaveBeenCalled();
    });
  });

  /**
   * A single-use ticket means EventSource's OWN retry — which replays the same URL — would
   * 401 forever. So the client took the retry over. This is the test that proves it: an
   * error must produce a SECOND mint and a SECOND, DIFFERENT ticket.
   */
  describe('reconnect re-mints rather than replaying a spent ticket', () => {
    it('a connection error closes the stream and reconnects with a FRESH ticket', async () => {
      jest.useFakeTimers();
      const handle = await startConnected({ token: 'test-token', queryClient });

      const first = mockEventSource;
      expect(first.url).toContain('ticket=ticket-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      first.triggerError();
      expect(first.readyState).toBe(2); // we closed it; EventSource's own retry is disabled

      // Advance past the maximum first-attempt backoff (base + jitter ceiling).
      jest.advanceTimersByTime(sseReconnectConfig.baseDelayMs + sseReconnectConfig.jitterMs + 1);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = ((window as any).EventSource as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(urls.length).toBe(2);
      expect(urls[1]).toContain('ticket=ticket-2');
      expect(urls[1]).not.toContain('ticket=ticket-1');

      handle.stop();
    });

    it('stop() cancels a scheduled reconnect — no further mint happens', async () => {
      jest.useFakeTimers();
      const handle = await startConnected({ token: 'test-token', queryClient });

      mockEventSource.triggerError();
      handle.stop();

      jest.advanceTimersByTime(sseReconnectConfig.maxDelayMs * 2);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

});