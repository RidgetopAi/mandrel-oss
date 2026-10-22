import { QueryClient } from '@tanstack/react-query';
import { startSse, SseOptions } from './sse';
import { AidisDbEvent } from '../types/events';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  
  url: string;
  listeners: Map<string, Set<(e: MessageEvent) => void>> = new Map();
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readyState: number = 0;
  CONNECTING = 0;
  OPEN = 1;
  CLOSED = 2;

  constructor(url: string) {
    this.url = url;
    this.readyState = this.CONNECTING;
    MockEventSource.instances.push(this);
    
    // Simulate connection opening
    setTimeout(() => {
      this.readyState = this.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  addEventListener(event: string, handler: (e: MessageEvent) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  removeEventListener(event: string, handler: (e: MessageEvent) => void) {
    this.listeners.get(event)?.delete(handler);
  }

  close() {
    this.readyState = this.CLOSED;
  }

  // Test helper to simulate receiving an event
  simulateEvent(eventName: string, data: any) {
    const handlers = this.listeners.get(eventName);
    if (handlers) {
      const event = new MessageEvent(eventName, {
        data: JSON.stringify(data),
      });
      handlers.forEach(handler => handler(event));
    }
  }

  // Test helper to simulate error
  simulateError() {
    this.onerror?.(new Event('error'));
  }

  static reset() {
    MockEventSource.instances = [];
  }

  static getLastInstance(): MockEventSource | undefined {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

describe('SSE Error Scenarios and Recovery (Frontend)', () => {
  let queryClient: QueryClient;
  let originalEventSource: any;
  let fetchMock: jest.Mock;
  let ticketCounter: number;

  /**
   * `startSse` mints a connect ticket over fetch BEFORE opening the EventSource, because
   * the session JWT may no longer travel in the URL. Draining the
   * microtask queue is what makes the connection observable to the synchronous assertions
   * below; nothing else about these tests changed.
   */
  const start = async (options: SseOptions) => {
    const handle = startSse(options);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return handle;
  };

  beforeEach(() => {
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
    
    originalEventSource = (window as any).EventSource;
    (window as any).EventSource = MockEventSource;
    MockEventSource.reset();

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
    (window as any).EventSource = originalEventSource;
    jest.restoreAllMocks();
  });

  describe('Browser Compatibility', () => {
    it('should handle missing EventSource support gracefully', async () => {
      delete (window as any).EventSource;

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      const handle = startSse(options);

      expect(handle.unsupported).toBe(true);
      expect(console.warn).toHaveBeenCalledWith('SSE not supported by browser');
    });

    it('should return working stop function when unsupported', async () => {
      delete (window as any).EventSource;

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      const handle = startSse(options);

      expect(() => handle.stop()).not.toThrow();
    });
  });

  describe('Connection Failures', () => {
    it('should trigger onError callback on connection error', async () => {
      const onError = jest.fn();

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
        onError,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      es.simulateError();

      expect(onError).toHaveBeenCalled();
    });

    it('should invalidate dashboard stats on error', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      es.simulateError();

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dashboardStats'],
      });
    });

    it('should log connection errors', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      es.simulateError();

      expect(console.error).toHaveBeenCalledWith(
        'SSE connection error:',
        expect.any(Event)
      );
    });
  });

  describe('Event Parsing Errors', () => {
    it('should handle malformed JSON in event data', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      
      // Manually trigger with bad JSON
      const badHandler = es.listeners.get('contexts')?.values().next().value;
      if (badHandler) {
        const badEvent = new MessageEvent('contexts', {
          data: 'not valid json {{{',
        });
        badHandler(badEvent);
      }

      expect(console.error).toHaveBeenCalledWith(
        'Failed to parse SSE event:',
        expect.any(Error)
      );
    });

    it('should continue processing after parse error', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      
      // Send bad event
      const badHandler = es.listeners.get('tasks')?.values().next().value;
      if (badHandler) {
        const badEvent = new MessageEvent('tasks', { data: 'bad json' });
        badHandler(badEvent);
      }

      // Send good event
      const validEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'insert',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      es.simulateEvent('tasks', validEvent);

      // Should still process valid events
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['tasks'],
      });
    });
  });

  describe('Cache Invalidation', () => {
    it('should invalidate correct caches for task events', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      es.simulateEvent('tasks', event);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboardStats'] });
    });

    it('should invalidate correct caches for context events', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      const event: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        at: new Date().toISOString(),
      };

      es.simulateEvent('contexts', event);

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['contexts', 'list'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['contexts', 'stats'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['dashboardStats'] });
    });

    it('should dispatch custom window events for task updates', async () => {
      const dispatchSpy = jest.spyOn(window, 'dispatchEvent');

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      es.simulateEvent('tasks', event);

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'aidis:task-update',
          detail: event,
        })
      );
    });

    it('should handle unknown entity types gracefully', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      const event: AidisDbEvent = {
        entity: 'unknown' as any,
        action: 'insert',
        id: 'unk-123',
        at: new Date().toISOString(),
      };

      // The client only registers listeners for known entity names, so an
      // unrecognised entity reaches the cache-invalidation switch via a
      // registered transport listener carrying an unknown `entity` in its
      // payload. That path hits the default branch and warns (without throwing).
      expect(() => es.simulateEvent('contexts', event)).not.toThrow();
      expect(console.warn).toHaveBeenCalledWith(
        'Unknown entity type for cache invalidation:',
        'unknown'
      );
    });
  });

  describe('Connection Lifecycle', () => {
    it('should call onConnect when connection opens', async () => {
      const onConnect = jest.fn();

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
        onConnect,
      };

      await start(options);

      // MockEventSource opens on a macrotask, so wait one out.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(onConnect).toHaveBeenCalled();
    });

    it('should call onDisconnect when stop is called', async () => {
      const onDisconnect = jest.fn();

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
        onDisconnect,
      };

      const handle = await start(options);
      handle.stop();

      expect(onDisconnect).toHaveBeenCalled();
    });

    it('should close EventSource when stop is called', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      const handle = await start(options);
      const es = MockEventSource.getLastInstance()!;

      handle.stop();

      expect(es.readyState).toBe(es.CLOSED);
    });
  });

  describe('URL Construction', () => {
    it('carries a TICKET in the URL, never the session token', async () => {
      const options: SseOptions = {
        token: 'secret-token-123',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      expect(es.url).toContain('ticket=ticket-1');
      expect(es.url).not.toContain('secret-token-123');
      expect(es.url).not.toMatch(/[?&]token=/);
    });

    it('should include projectId when provided (real UUID)', async () => {
      // Only a real-UUID projectId is attached to the URL; a non-UUID is dropped
      // (see sse.test.ts self-heal cases). Use contoso's real voiceitt-bridge id.
      const validProjectId = 'c875b2af-9020-41b7-9595-d70221603464';
      const options: SseOptions = {
        token: 'test-token',
        projectId: validProjectId,
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      expect(es.url).toContain(`projectId=${validProjectId}`);
    });

    it('should include entities when provided', async () => {
      const options: SseOptions = {
        token: 'test-token',
        entities: ['tasks', 'contexts'],
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      expect(es.url).toContain('entities=tasks%2Ccontexts');
    });

    it('should use same-origin (relative) URL when env var not set', async () => {
      vi.unstubAllEnvs();

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      // Same-origin: empty base yields a relative /api/events URL.
      expect(es.url).toMatch(/^\/api\/events\?/);
      expect(es.url).not.toContain('http://localhost:5000'); // reserved-port-ok: asserts the URL does NOT carry prod's :5000 — names it, never binds it
    });

    it('should strip trailing /api from an absolute VITE_API_URL', async () => {
      vi.stubEnv('VITE_API_URL', 'http://example.com/api');

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      expect(es.url).toContain('http://example.com/api/events');
      expect(es.url).not.toContain('/api/api/');

      vi.unstubAllEnvs();
    });
  });

  describe('Multiple Event Types', () => {
    it('should register listeners for all entity types', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      
      const expectedTypes = ['contexts', 'tasks', 'decisions', 'projects', 'sessions', 'system'];
      expectedTypes.forEach(type => {
        expect(es.listeners.has(type)).toBe(true);
      });
    });

    it('should handle events from all entity types', async () => {
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;

      const events: AidisDbEvent[] = [
        { entity: 'tasks', action: 'insert', id: 't1', at: new Date().toISOString() },
        { entity: 'contexts', action: 'update', id: 'c1', at: new Date().toISOString() },
        { entity: 'decisions', action: 'delete', id: 'd1', at: new Date().toISOString() },
        { entity: 'projects', action: 'insert', id: 'p1', at: new Date().toISOString() },
        { entity: 'sessions', action: 'update', id: 's1', at: new Date().toISOString() },
      ];

      events.forEach(evt => es.simulateEvent(evt.entity, evt));

      // Each should have triggered cache invalidation
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['contexts', 'list'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['decisions'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sessions'] });
    });
  });

  describe('Logging', () => {
    it('should log connection start with the credential redacted', async () => {
      const options: SseOptions = {
        token: 'secret-token-123',
        projectId: 'proj-456',
        entities: ['tasks'],
        queryClient,
      };

      await start(options);

      expect(console.log).toHaveBeenCalledWith(
        'Starting SSE connection:',
        expect.objectContaining({
          projectId: 'proj-456',
          entities: ['tasks'],
          url: expect.stringMatching(/ticket=\*\*\*/),
        })
      );
    });

    it('should log successful connection', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(console.log).toHaveBeenCalledWith('SSE connection opened');
    });

    it('should log event reception', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      await start(options);

      const es = MockEventSource.getLastInstance()!;
      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'insert',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      es.simulateEvent('tasks', event);

      expect(console.log).toHaveBeenCalledWith('SSE event received:', event);
    });

    it('should log disconnection', async () => {
      const options: SseOptions = {
        token: 'test-token',
        queryClient,
      };

      const handle = await start(options);
      handle.stop();

      expect(console.log).toHaveBeenCalledWith('Stopping SSE connection');
    });
  });
});
