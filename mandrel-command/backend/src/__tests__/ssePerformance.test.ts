import { Request, Response } from 'express';
import { AidisDbEvent } from '../types/events';

let sseService: any;
let logger: any;

/**
 * SSE Performance and Load Tests
 * 
 * Tests system behavior under load:
 * - Multiple concurrent connections
 * - High-frequency event broadcasting
 * - Memory usage patterns
 * - Connection scaling
 */
describe('SSE Performance and Load Tests', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.clearAllMocks();

    jest.doMock('../config/logger', () => ({
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
    }));

    const sseModule = require('../services/sse');
    sseService = sseModule.sseService;
    logger = require('../config/logger').logger;
  });

  afterEach(() => {
    sseService.disconnectAll();
    jest.useRealTimers();
  });

  /**
   * Create mock client connection
   */
  function createMockConnection(userId: string, options: {
    projectId?: string;
    entities?: string;
  } = {}) {
    const mockWrite = jest.fn();
    const mockEnd = jest.fn();
    const mockSetHeader = jest.fn();
    const mockFlushHeaders = jest.fn();

    const mockRequest: Partial<Request> = {
      query: {
        entities: options.entities,
      },
      on: jest.fn(),
    } as any;
    (mockRequest as any).user = { id: userId };
    // project scope arrives ALREADY RESOLVED AND AUTHORIZED from
    // middleware, not from req.query. `sseAuthorizedProjectIds: null` = an admin caller
    // (all projects), preserving what every assertion in this file measures.
    if (options.projectId !== undefined) {
      (mockRequest as any).project = { id: options.projectId };
    }
    (mockRequest as any).sseAuthorizedProjectIds = null;

    const mockResponse: Partial<Response> = {
      setHeader: mockSetHeader,
      flushHeaders: mockFlushHeaders,
      write: mockWrite,
      end: mockEnd,
      writableEnded: false,
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };

    return { mockRequest, mockResponse, mockWrite, mockEnd };
  }

  describe('Concurrent Connections', () => {
    it('should handle 100 concurrent connections efficiently', () => {
      const startTime = Date.now();
      const connections = [];

      // Create 100 connections
      for (let i = 0; i < 100; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        connections.push({ mockRequest, mockResponse });
      }

      const connectionTime = Date.now() - startTime;

      // Should complete in reasonable time
      expect(connectionTime).toBeLessThan(1000); // 1 second for 100 connections

      // All connections should be tracked
      const stats = sseService.getStats();
      expect(stats.totalConnections).toBe(100);
    });

    it('should handle max connections per user without degradation', () => {
      const userId = 'heavy-user';
      const connections = [];

      // Create 5 connections (max per user)
      for (let i = 0; i < 5; i++) {
        const { mockRequest, mockResponse } = createMockConnection(userId);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        connections.push({ mockRequest, mockResponse });
      }

      expect(sseService.getStats().totalConnections).toBe(5);

      // 6th connection should be rejected cleanly
      const { mockRequest: req6, mockResponse: res6 } = createMockConnection(userId);
      sseService.handleSubscribe(req6 as Request, res6 as Response);

      expect((res6.status as jest.Mock)).toHaveBeenCalledWith(503);
    });

    it('should scale to multiple users with max connections each', () => {
      const userCount = 20;
      const connectionsPerUser = 5;

      for (let u = 0; u < userCount; u++) {
        for (let c = 0; c < connectionsPerUser; c++) {
          const { mockRequest, mockResponse } = createMockConnection(`user-${u}`);
          sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        }
      }

      const stats = sseService.getStats();
      expect(stats.totalConnections).toBe(userCount * connectionsPerUser); // 100 total
      expect(Object.keys(stats.connectionsByUser).length).toBe(userCount);
    });
  });

  describe('Event Broadcasting Performance', () => {
    it('should broadcast to 100 clients in under 100ms', () => {
      // Setup 100 clients
      for (let i = 0; i < 100; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }

      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      const startTime = Date.now();
      sseService.broadcastDbEvent(event);
      const broadcastTime = Date.now() - startTime;

      expect(broadcastTime).toBeLessThan(100); // Should be very fast
    });

    it('should handle high-frequency event broadcasting', () => {
      // Setup 50 clients
      const clients = [];
      for (let i = 0; i < 50; i++) {
        const { mockRequest, mockResponse, mockWrite } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        clients.push({ mockWrite });
      }

      // Broadcast 1000 events rapidly
      const eventCount = 1000;
      const startTime = Date.now();

      for (let i = 0; i < eventCount; i++) {
        const event: AidisDbEvent = {
          entity: 'tasks',
          action: 'update',
          id: `task-${i}`,
          at: new Date().toISOString(),
        };
        sseService.broadcastDbEvent(event);
      }

      const totalTime = Date.now() - startTime;
      const eventsPerSecond = (eventCount / totalTime) * 1000;

      // Should handle at least 1000 events/second
      expect(eventsPerSecond).toBeGreaterThan(1000);

      // Each client should have received all events
      clients.forEach(({ mockWrite }) => {
        const eventWrites = mockWrite.mock.calls.filter(
          call => call[0].includes('event: tasks')
        );
        expect(eventWrites.length).toBeGreaterThan(0);
      });
    });

    it('should efficiently filter events for targeted clients', () => {
      // Create clients with different filters
      const contextClients = [];
      const taskClients = [];
      
      for (let i = 0; i < 25; i++) {
        const { mockRequest, mockResponse, mockWrite } = createMockConnection(`ctx-user-${i}`, {
          entities: 'contexts',
        });
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        contextClients.push({ mockWrite });
      }

      for (let i = 0; i < 25; i++) {
        const { mockRequest, mockResponse, mockWrite } = createMockConnection(`task-user-${i}`, {
          entities: 'tasks',
        });
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        taskClients.push({ mockWrite });
      }

      jest.clearAllMocks();

      // Broadcast context event
      const contextEvent: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        at: new Date().toISOString(),
      };

      sseService.broadcastDbEvent(contextEvent);

      // Only context clients should receive it
      contextClients.forEach(({ mockWrite }) => {
        expect(mockWrite).toHaveBeenCalled();
      });

      taskClients.forEach(({ mockWrite }) => {
        expect(mockWrite).not.toHaveBeenCalled();
      });
    });
  });

  describe('Heartbeat Performance', () => {
    it('should handle heartbeat for 100 connections efficiently', () => {
      // Setup 100 clients
      const clients = [];
      for (let i = 0; i < 100; i++) {
        const { mockRequest, mockResponse, mockWrite } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        clients.push({ mockWrite });
      }

      jest.clearAllMocks();

      // Advance to trigger heartbeat
      jest.advanceTimersByTime(15000);

      // All clients should receive heartbeat
      clients.forEach(({ mockWrite }) => {
        expect(mockWrite).toHaveBeenCalledWith(': keep-alive\n\n');
      });

      // Heartbeat should execute without errors for all 100 clients
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Heartbeat write failed'),
        expect.anything()
      );
    });

    it('should maintain heartbeat under load', () => {
      // Setup 50 clients
      for (let i = 0; i < 50; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }

      // Simulate 1 minute of operation with concurrent events and heartbeats
      for (let minute = 0; minute < 4; minute++) {
        // Broadcast events
        for (let e = 0; e < 10; e++) {
          const event: AidisDbEvent = {
            entity: 'tasks',
            action: 'update',
            id: `task-${minute}-${e}`,
            at: new Date().toISOString(),
          };
          sseService.broadcastDbEvent(event);
        }

        // Advance time for heartbeat
        jest.advanceTimersByTime(15000);
      }

      // All connections should still be active
      expect(sseService.getStats().totalConnections).toBe(50);
    });
  });

  describe('Memory and Resource Management', () => {
    it('should properly clean up disconnected clients', () => {
      const connections = [];

      // Create 50 connections
      for (let i = 0; i < 50; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        connections.push({ mockRequest, mockResponse });
      }

      expect(sseService.getStats().totalConnections).toBe(50);

      // Disconnect half of them
      for (let i = 0; i < 25; i++) {
        const onMock = connections[i].mockRequest.on as jest.Mock;
        const closeHandler = onMock.mock.calls.find(
          ([event]: [string]) => event === 'close'
        )?.[1];
        closeHandler?.();
      }

      expect(sseService.getStats().totalConnections).toBe(25);

      // Add 25 new connections
      for (let i = 50; i < 75; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }

      expect(sseService.getStats().totalConnections).toBe(50);
    });

    it('should handle rapid connection churn', () => {
      // Simulate rapid connect/disconnect cycles
      for (let cycle = 0; cycle < 20; cycle++) {
        // Connect 10 clients
        const connections = [];
        for (let i = 0; i < 10; i++) {
          const { mockRequest, mockResponse } = createMockConnection(`user-${cycle}-${i}`);
          sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
          connections.push({ mockRequest });
        }

        // Immediately disconnect them
        connections.forEach(({ mockRequest }) => {
          const onMock = mockRequest.on as jest.Mock;
          const closeHandler = onMock.mock.calls.find(
            ([event]: [string]) => event === 'close'
          )?.[1];
          closeHandler?.();
        });
      }

      // Should have no lingering connections
      expect(sseService.getStats().totalConnections).toBe(0);
    });
  });

  describe('Project Filtering Performance', () => {
    it('should efficiently filter by projectId at scale', () => {
      const projectCount = 10;
      const clientsPerProject = 10;

      // Create clients for each project
      const clientsByProject = new Map<string, any[]>();
      
      for (let p = 0; p < projectCount; p++) {
        const projectId = `proj-${p}`;
        const clients = [];
        
        for (let c = 0; c < clientsPerProject; c++) {
          const { mockRequest, mockResponse, mockWrite } = createMockConnection(
            `user-${p}-${c}`,
            { projectId }
          );
          sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
          clients.push({ mockWrite });
        }
        
        clientsByProject.set(projectId, clients);
      }

      expect(sseService.getStats().totalConnections).toBe(projectCount * clientsPerProject);

      jest.clearAllMocks();

      // Broadcast event for specific project
      const targetProject = 'proj-5';
      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-123',
        projectId: targetProject,
        at: new Date().toISOString(),
      };

      const startTime = Date.now();
      sseService.broadcastDbEvent(event);
      const filterTime = Date.now() - startTime;

      // Should filter quickly even with 100 total clients
      expect(filterTime).toBeLessThan(50);

      // Only clients for target project should receive event
      clientsByProject.forEach((clients, projectId) => {
        clients.forEach(({ mockWrite }) => {
          if (projectId === targetProject) {
            expect(mockWrite).toHaveBeenCalled();
          } else {
            expect(mockWrite).not.toHaveBeenCalled();
          }
        });
      });
    });
  });

  describe('Stress Tests', () => {
    it('should handle sustained high load', () => {
      // Setup 100 clients
      for (let i = 0; i < 100; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }

      // Simulate 10 minutes of sustained load
      const iterations = 40; // 10 minutes / 15 second intervals
      
      for (let i = 0; i < iterations; i++) {
        // Broadcast 10 events
        for (let e = 0; e < 10; e++) {
          const event: AidisDbEvent = {
            entity: 'tasks',
            action: 'update',
            id: `task-${i}-${e}`,
            at: new Date().toISOString(),
          };
          sseService.broadcastDbEvent(event);
        }

        // Trigger heartbeat
        jest.advanceTimersByTime(15000);
      }

      // All connections should still be active
      const stats = sseService.getStats();
      expect(stats.totalConnections).toBe(100);
    });

    it('should recover from partial failure under load', () => {
      const clients = [];
      
      // Create 50 clients
      for (let i = 0; i < 50; i++) {
        const { mockRequest, mockResponse, mockWrite } = createMockConnection(`user-${i}`);
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
        clients.push({ mockWrite });
      }

      // Make some clients fail during broadcast
      for (let i = 0; i < 10; i++) {
        clients[i].mockWrite.mockImplementationOnce(() => {
          throw new Error('Client write failed');
        });
      }

      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      // Should handle failures gracefully
      expect(() => sseService.broadcastDbEvent(event)).not.toThrow();

      // Failed clients should be removed
      expect(sseService.getStats().totalConnections).toBe(40);

      // Remaining clients should still work
      const event2: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-456',
        at: new Date().toISOString(),
      };

      expect(() => sseService.broadcastDbEvent(event2)).not.toThrow();
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should track stats efficiently under load', () => {
      // Create connections
      for (let i = 0; i < 100; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i % 20}`); // 20 users, 5 connections each
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }

      // Get stats multiple times (simulating monitoring)
      const statCalls = 1000;
      const startTime = Date.now();

      for (let i = 0; i < statCalls; i++) {
        const stats = sseService.getStats();
        expect(stats.totalConnections).toBe(100);
      }

      const statsTime = Date.now() - startTime;

      // Should be very fast
      expect(statsTime).toBeLessThan(100);
    });

    it('should provide accurate client details at scale', () => {
      const userCount = 50;
      
      for (let i = 0; i < userCount; i++) {
        const { mockRequest, mockResponse } = createMockConnection(`user-${i}`, {
          projectId: `proj-${i % 5}`,
          entities: i % 2 === 0 ? 'tasks,contexts' : 'decisions',
        });
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }

      const clients = sseService.getClients();

      expect(clients).toHaveLength(userCount);
      
      clients.forEach((client: any) => {
        expect(client).toHaveProperty('userId');
        expect(client).toHaveProperty('connectedAt');
        expect(client).toHaveProperty('connectionDurationMs');
      });
    });
  });
});
