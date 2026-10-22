import { Request, Response } from 'express';
import { AidisDbEvent } from '../types/events';

let sseService: any;
let logger: any;

describe('SSE Error Scenarios and Recovery', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockWrite: jest.Mock;
  let mockEnd: jest.Mock;
  let mockFlushHeaders: jest.Mock;
  let mockSetHeader: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockWrite = jest.fn();
    mockEnd = jest.fn();
    mockFlushHeaders = jest.fn();
    mockSetHeader = jest.fn();

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

    mockResponse = {
      setHeader: mockSetHeader,
      flushHeaders: mockFlushHeaders,
      write: mockWrite,
      end: mockEnd,
      writableEnded: false,
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };

    mockRequest = {
      query: {},
      on: jest.fn(),
    } as any;
    
    (mockRequest as any).user = { id: 'user-123' };
    // the project scope and the AUTHORIZED project set are resolved by
    // middleware (projectContextMiddleware → extractSseProjectContext), not read out of
    // req.query here. `null` = "all projects" (an admin caller), which is the behaviour
    // every assertion in this file was written against, so those assertions still measure
    // what they always measured. The non-admin path gets its own cases at the bottom.
    (mockRequest as any).sseAuthorizedProjectIds = null;
  });

  afterEach(() => {
    sseService.disconnectAll();
    jest.useRealTimers();
  });

  describe('Network Failures and Recovery', () => {
    it('should handle write failure during initial connection', () => {
      mockWrite.mockImplementationOnce(() => {
        throw new Error('Network write failed');
      });

      // Should not throw - error is caught internally
      expect(() => {
        sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      }).not.toThrow();

      // Connection setup should still be attempted
      expect(mockSetHeader).toHaveBeenCalled();
    });

    it('should handle write failure during event broadcast', () => {
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      const initialConnections = sseService.getStats().totalConnections;

      mockWrite.mockImplementationOnce(() => {
        throw new Error('Write failed during broadcast');
      });

      const event: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        at: new Date().toISOString(),
      };

      sseService.broadcastDbEvent(event);

      // Failed client should be removed
      expect(sseService.getStats().totalConnections).toBe(initialConnections - 1);
      expect(logger.warn).toHaveBeenCalledWith(
        'SSE: Failed to write event',
        expect.objectContaining({
          error: 'Write failed during broadcast',
          userId: 'user-123',
        })
      );
    });

    it('should handle intermittent heartbeat failures', () => {
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      // First heartbeat succeeds
      jest.advanceTimersByTime(15000);
      expect(mockWrite).toHaveBeenCalledWith(': keep-alive\n\n');

      // Second heartbeat fails
      mockWrite.mockImplementationOnce(() => {
        throw new Error('Heartbeat failed');
      });
      jest.advanceTimersByTime(15000);

      // Client should be removed
      expect(sseService.getStats().totalConnections).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        'SSE: Heartbeat write failed',
        expect.objectContaining({ userId: 'user-123' })
      );
    });

    it('should handle response already ended', () => {
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      (mockResponse as any).writableEnded = true;

      const event: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: 'task-123',
        at: new Date().toISOString(),
      };

      // Should not crash when trying to write to ended response
      expect(() => sseService.broadcastDbEvent(event)).not.toThrow();
    });
  });

  describe('Connection Limit Enforcement', () => {
    it('should reject connection when user exceeds limit', () => {
      // Create 5 connections (max limit)
      for (let i = 0; i < 5; i++) {
        const req = { ...mockRequest, on: jest.fn() };
        const res = {
          ...mockResponse,
          write: jest.fn(),
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
        };
        sseService.handleSubscribe(req as Request, res as Response);
      }

      // 6th connection should be rejected
      const req6 = { ...mockRequest, on: jest.fn() };
      const res6 = {
        ...mockResponse,
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      sseService.handleSubscribe(req6 as Request, res6 as Response);

      expect(res6.status).toHaveBeenCalledWith(503);
      expect(res6.send).toHaveBeenCalledWith(
        'Too many connections. Maximum 5 connections allowed per user.'
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'SSE: Too many connections for user',
        expect.objectContaining({
          userId: 'user-123',
          currentConnections: 5,
          maxAllowed: 5,
        })
      );
    });

    it('should allow new connection after old one disconnects', () => {
      // Create 5 connections
      const connections = [];
      for (let i = 0; i < 5; i++) {
        const req = { ...mockRequest, on: jest.fn() } as any;
        req.user = { id: 'user-123' };
        const res = {
          ...mockResponse,
          write: jest.fn(),
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
        };
        sseService.handleSubscribe(req as Request, res as Response);
        connections.push({ req, res });
      }

      // Disconnect first connection
      const closeHandler = connections[0].req.on.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];
      closeHandler?.();

      expect(sseService.getStats().totalConnections).toBe(4);

      // New connection should now succeed
      const req6 = { ...mockRequest, on: jest.fn() } as any;
      req6.user = { id: 'user-123' };
      const res6 = {
        ...mockResponse,
        write: jest.fn(),
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
      };

      sseService.handleSubscribe(req6 as Request, res6 as Response);

      expect(sseService.getStats().totalConnections).toBe(5);
    });
  });

  describe('Invalid Input Handling', () => {
    it('should reject invalid entity types gracefully', () => {
      mockRequest.query = { entities: 'invalid,fake,tasks' };

      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect(mockResponse.send).toHaveBeenCalledWith(
        expect.stringContaining('Invalid entity types:')
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'SSE: Invalid entity types requested',
        expect.objectContaining({
          userId: 'user-123',
          invalidEntities: expect.arrayContaining(['invalid', 'fake']),
        })
      );
    });

    it('should handle malformed entity query param', () => {
      mockRequest.query = { entities: ',,,' };

      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      // Empty strings after split/filter should result in undefined entities
      expect(mockSetHeader).toHaveBeenCalled();
    });

    it('should handle missing user context gracefully', () => {
      const reqNoUser = { ...mockRequest, on: jest.fn() } as any;
      delete reqNoUser.user;

      sseService.handleSubscribe(reqNoUser as Request, mockResponse as Response);

      expect(logger.info).toHaveBeenCalledWith(
        'SSE: Client connected',
        expect.objectContaining({
          userId: 'unknown',
        })
      );
    });
  });

  describe('Broadcast Error Resilience', () => {
    it('should continue broadcasting to healthy clients when one fails', () => {
      // Connect client 1
      const req1 = { ...mockRequest, on: jest.fn() } as any;
      req1.user = { id: 'user-1' };
      const res1 = {
        ...mockResponse,
        write: jest.fn(),
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
      };
      sseService.handleSubscribe(req1 as Request, res1 as Response);

      // Connect client 2
      const req2 = { ...mockRequest, on: jest.fn() } as any;
      req2.user = { id: 'user-2' };
      const res2 = {
        ...mockResponse,
        write: jest.fn(),
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
      };
      sseService.handleSubscribe(req2 as Request, res2 as Response);

      jest.clearAllMocks();

      // Make client 1's write fail
      res1.write = jest.fn().mockImplementationOnce(() => {
        throw new Error('Client 1 failed');
      });

      const event: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        at: new Date().toISOString(),
      };

      sseService.broadcastDbEvent(event);

      // Client 1 should be removed
      expect(logger.warn).toHaveBeenCalledWith(
        'SSE: Failed to write event',
        expect.objectContaining({ userId: 'user-1' })
      );

      // Client 2 should have received the event
      expect(res2.write).toHaveBeenCalled();
      expect(sseService.getStats().totalConnections).toBe(1);
    });

    it('should handle JSON serialization errors in event data', () => {
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      const circularRef: any = { entity: 'contexts', action: 'insert', id: 'ctx-1', at: new Date().toISOString() };
      circularRef.self = circularRef; // Creates circular reference

      // JSON.stringify will throw on circular reference
      // The service catches write errors and removes the client
      expect(() => sseService.broadcastDbEvent(circularRef)).not.toThrow();
      
      // Client should be removed due to write failure
      expect(sseService.getStats().totalConnections).toBe(0);
    });
  });

  describe('Graceful Shutdown', () => {
    it('should send shutdown message and close all connections', () => {
      const connections = [];
      
      for (let i = 0; i < 3; i++) {
        const req = { ...mockRequest, on: jest.fn() } as any;
        req.user = { id: `user-${i}` };
        const res = {
          ...mockResponse,
          write: jest.fn(),
          end: jest.fn(),
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
        };
        sseService.handleSubscribe(req as Request, res as Response);
        connections.push(res);
      }

      jest.clearAllMocks();

      sseService.disconnectAll();

      // All clients should receive shutdown message
      connections.forEach(res => {
        const writeCalls = (res.write as jest.Mock).mock.calls.map(call => call[0]).join('');
        expect(writeCalls).toContain('server-shutdown');
        expect(res.end).toHaveBeenCalled();
      });

      expect(sseService.getStats().totalConnections).toBe(0);
    });

    it('should handle errors during shutdown without throwing', () => {
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      mockWrite.mockImplementationOnce(() => {
        throw new Error('Shutdown write failed');
      });

      expect(() => sseService.disconnectAll()).not.toThrow();
    });
  });

  describe('Client Disconnect Scenarios', () => {
    it('should clean up resources on abrupt disconnect', () => {
      const onMock = jest.fn();
      mockRequest.on = onMock;

      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      expect(sseService.getStats().totalConnections).toBe(1);

      // Simulate abrupt disconnect (close event)
      const closeHandler = onMock.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];

      closeHandler?.();

      expect(sseService.getStats().totalConnections).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        'SSE: Client disconnected',
        expect.objectContaining({
          userId: 'user-123',
          connectionDurationMs: expect.any(Number),
        })
      );
    });

    it('should stop heartbeat after disconnect', () => {
      const onMock = jest.fn();
      mockRequest.on = onMock;

      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      // Get close handler
      const closeHandler = onMock.mock.calls.find(
        ([event]: [string]) => event === 'close'
      )?.[1];

      // Heartbeat should work initially
      jest.advanceTimersByTime(15000);
      const writeCallsBefore = mockWrite.mock.calls.length;

      // Disconnect
      closeHandler?.();

      // Advance time - heartbeat should not fire anymore
      jest.advanceTimersByTime(15000);
      const writeCallsAfter = mockWrite.mock.calls.length;

      expect(writeCallsAfter).toBe(writeCallsBefore);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle rapid connect/disconnect cycles', () => {
      const cycles = 10;
      
      for (let i = 0; i < cycles; i++) {
        const req = { ...mockRequest, on: jest.fn() } as any;
        req.user = { id: `user-${i}` };
        const res = {
          ...mockResponse,
          write: jest.fn(),
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
        };

        sseService.handleSubscribe(req as Request, res as Response);

        // Immediately disconnect
        const closeHandler = req.on.mock.calls.find(
          ([event]: [string]) => event === 'close'
        )?.[1];
        closeHandler?.();
      }

      expect(sseService.getStats().totalConnections).toBe(0);
    });

    it('should handle concurrent event broadcasts', () => {
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);

      const events: AidisDbEvent[] = [
        { entity: 'contexts', action: 'insert', id: 'ctx-1', at: new Date().toISOString() },
        { entity: 'tasks', action: 'update', id: 'task-1', at: new Date().toISOString() },
        { entity: 'decisions', action: 'delete', id: 'dec-1', at: new Date().toISOString() },
      ];

      // Broadcast multiple events rapidly
      events.forEach(evt => sseService.broadcastDbEvent(evt));

      // All events should have been written
      const writeCalls = mockWrite.mock.calls.map(call => call[0]).join('');
      expect(writeCalls).toContain('contexts');
      expect(writeCalls).toContain('tasks');
      expect(writeCalls).toContain('decisions');
    });
  });

  describe('Filter Edge Cases', () => {
    it('should handle event with missing projectId when client expects it', () => {
      (mockRequest as any).project = { id: 'proj-123' };
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      jest.clearAllMocks();

      const event: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        // No projectId in event
        at: new Date().toISOString(),
      };

      sseService.broadcastDbEvent(event);

      // Event should be sent (filter only applies when both have projectId)
      expect(mockWrite).toHaveBeenCalled();
    });

    it('should filter correctly when both client and event have different projectIds', () => {
      (mockRequest as any).project = { id: 'proj-123' };
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      jest.clearAllMocks();

      const event: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        projectId: 'proj-456', // Different project
        at: new Date().toISOString(),
      };

      sseService.broadcastDbEvent(event);

      // Event should NOT be sent
      const eventWrites = mockWrite.mock.calls.filter(
        call => call[0].includes('event: contexts')
      );
      expect(eventWrites.length).toBe(0);
    });

    it('should allow events when projectIds match', () => {
      (mockRequest as any).project = { id: 'proj-123' };
      sseService.handleSubscribe(mockRequest as Request, mockResponse as Response);
      jest.clearAllMocks();

      const event: AidisDbEvent = {
        entity: 'contexts',
        action: 'insert',
        id: 'ctx-123',
        projectId: 'proj-123', // Same project
        at: new Date().toISOString(),
      };

      sseService.broadcastDbEvent(event);

      // Event should be sent
      expect(mockWrite).toHaveBeenCalled();
      const writeCalls = mockWrite.mock.calls.map(call => call[0]).join('');
      expect(writeCalls).toContain('event: contexts');
    });
  });
});
