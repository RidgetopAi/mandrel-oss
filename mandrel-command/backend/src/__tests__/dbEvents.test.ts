let DbEvents: any;
let dbEvents: any;
let Client: jest.Mock;
let logger: any;
let sseService: any;
let mockClient: any;
let mockConnect: jest.Mock;
let mockQuery: jest.Mock;
let mockEnd: jest.Mock;
let mockOn: jest.Mock;

describe('DbEvents Service', () => { // db-gate-exempt: NOT a DB suite — `pg` is jest.doMock'd at line 33, so `require('pg').Client` is a mock and no connection is ever opened
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockConnect = jest.fn().mockResolvedValue(undefined);
    // start() runs `SELECT ... FROM pg_listening_channels()` and destructures
    // `.rows`, so the mock must resolve a result-shaped object (not undefined),
    // otherwise start() throws before registering the error/end handlers.
    mockQuery = jest.fn().mockResolvedValue({ rows: [{ channels: ['aidis_changes'] }] });
    mockEnd = jest.fn().mockResolvedValue(undefined);
    mockOn = jest.fn();

    mockClient = {
      connect: mockConnect,
      query: mockQuery,
      end: mockEnd,
      on: mockOn,
    };

    jest.doMock('pg', () => ({
      Client: jest.fn().mockImplementation(() => mockClient),
    }));

    jest.doMock('../config/logger', () => ({
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      },
    }));

    jest.doMock('../services/sse', () => ({
      sseService: {
        broadcastDbEvent: jest.fn(),
      },
    }));

    const dbEventsModule = require('../services/dbEvents');
    DbEvents = dbEventsModule.DbEvents;
    dbEvents = new DbEvents();

    Client = require('pg').Client;
    logger = require('../config/logger').logger;
    sseService = require('../services/sse').sseService;
  });

  afterEach(async () => {
    await dbEvents.stop?.();
    jest.useRealTimers();
  });

  const getHandler = (event: string) =>
    mockOn.mock.calls.find(([evt]: [string, Function]) => evt === event)?.[1];

  describe('start()', () => {
    it('should successfully connect to PostgreSQL and listen to aidis_changes', async () => {
      await dbEvents.start();

      expect(Client).toHaveBeenCalledWith({
        user: expect.any(String),
        host: expect.any(String),
        database: expect.any(String),
        password: expect.any(String),
        port: expect.any(Number),
        application_name: expect.any(String),
      });
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith('LISTEN aidis_changes');
      expect(logger.info).toHaveBeenCalledWith(
        'DB Events Listener started',
        expect.objectContaining({ channel: 'aidis_changes' })
      );
    });

    it('should register notification handler', async () => {
      await dbEvents.start();

      expect(mockOn).toHaveBeenCalledWith('notification', expect.any(Function));
    });

    it('should register error handler', async () => {
      await dbEvents.start();

      expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should register end handler', async () => {
      await dbEvents.start();

      expect(mockOn).toHaveBeenCalledWith('end', expect.any(Function));
    });

    it('should not start during shutdown', async () => {
      await dbEvents.start();
      await dbEvents.stop();
      
      jest.clearAllMocks();
      await dbEvents.start();

      expect(mockConnect).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('DB Events Listener: Cannot start during shutdown');
    });

    it('should schedule reconnect on connection failure', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection failed'));

      await dbEvents.start();

      expect(logger.error).toHaveBeenCalledWith(
        'DB Events: Failed to start listener',
        expect.objectContaining({ error: 'Connection failed' })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'DB Events: Scheduling reconnect',
        expect.objectContaining({ attempt: 1, delayMs: 2000 })
      );
    });
  });

  describe('notification handling', () => {
    beforeEach(async () => {
      await dbEvents.start();
    });

    it('should parse valid JSON payload and broadcast to SSE', () => {
      const notificationHandler = getHandler('notification');
      const event = {
        table: 'contexts',
        operation: 'INSERT',
        id: '123',
        timestamp: '2025-10-30T12:00:00Z'
      };

      notificationHandler!({ payload: JSON.stringify(event) });

      expect(sseService.broadcastDbEvent).toHaveBeenCalledWith(event);
      expect(logger.debug).toHaveBeenCalledWith(
        'DB Events: Received notification',
        expect.objectContaining({ event })
      );
    });

    it('should handle notification without payload', () => {
      const notificationHandler = getHandler('notification');

      notificationHandler!({ payload: null });

      expect(sseService.broadcastDbEvent).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'DB Events: Received notification without payload',
        { channel: undefined }
      );
    });

    it('should handle invalid JSON payload', () => {
      const notificationHandler = getHandler('notification');

      notificationHandler!({ payload: 'invalid-json{' });

      expect(sseService.broadcastDbEvent).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'DB Events: Invalid NOTIFY payload',
        expect.objectContaining({ payload: 'invalid-json{' })
      );
    });

    it('should handle multiple sequential notifications', () => {
      const notificationHandler = getHandler('notification');
      const event1 = { table: 'contexts', operation: 'INSERT', id: '1' };
      const event2 = { table: 'tasks', operation: 'UPDATE', id: '2' };
      const event3 = { table: 'decisions', operation: 'DELETE', id: '3' };

      notificationHandler!({ payload: JSON.stringify(event1) });
      notificationHandler!({ payload: JSON.stringify(event2) });
      notificationHandler!({ payload: JSON.stringify(event3) });

      expect(sseService.broadcastDbEvent).toHaveBeenCalledTimes(3);
      expect(sseService.broadcastDbEvent).toHaveBeenNthCalledWith(1, event1);
      expect(sseService.broadcastDbEvent).toHaveBeenNthCalledWith(2, event2);
      expect(sseService.broadcastDbEvent).toHaveBeenNthCalledWith(3, event3);
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await dbEvents.start();
    });

    it('should handle client error and schedule reconnect', async () => {
      const errorHandler = getHandler('error');
      const error = new Error('Connection lost');
      
      await errorHandler!(error);

      expect(logger.error).toHaveBeenCalledWith(
        'DB Events: LISTEN error - will reconnect',
        expect.objectContaining({ error: 'Connection lost' })
      );
      expect(mockEnd).toHaveBeenCalled();
    });

    it('should log error with stack trace', async () => {
      const errorHandler = getHandler('error');
      const error = new Error('Database error');
      error.stack = 'Error: Database error\n  at test.ts:123';

      await errorHandler!(error);

      expect(logger.error).toHaveBeenCalledWith(
        'DB Events: LISTEN error - will reconnect',
        expect.objectContaining({ 
          error: 'Database error',
          stack: expect.stringContaining('Error: Database error')
        })
      );
    });
  });

  describe('reconnection logic', () => {
    it('should use exponential backoff for reconnection attempts', async () => {
      mockConnect.mockRejectedValue(new Error('Connection failed'));

      await dbEvents.start();
      
      expect(logger.info).toHaveBeenCalledWith(
        'DB Events: Scheduling reconnect',
        expect.objectContaining({ attempt: 1, delayMs: 2000 })
      );

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(logger.info).toHaveBeenCalledWith(
        'DB Events: Scheduling reconnect',
        expect.objectContaining({ attempt: 2, delayMs: 4000 })
      );

      jest.advanceTimersByTime(4000);
      await Promise.resolve();

      expect(logger.info).toHaveBeenCalledWith(
        'DB Events: Scheduling reconnect',
        expect.objectContaining({ attempt: 3, delayMs: 8000 })
      );
    });

    it('should cap reconnect delay at max (30 seconds)', async () => {
      mockConnect.mockRejectedValue(new Error('Connection failed'));

      await dbEvents.start();

      for (let i = 0; i < 10; i++) {
        const lastCall = (logger.info as jest.Mock).mock.calls
          .filter((call: any[]) => call[0] === 'DB Events: Scheduling reconnect')
          .pop();
        
        const delay = lastCall[1].delayMs;
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
      }

      const lastScheduleCall = (logger.info as jest.Mock).mock.calls
        .filter((call: any[]) => call[0] === 'DB Events: Scheduling reconnect')
        .pop();

      expect(lastScheduleCall[1].delayMs).toBe(30000);
    });

    it('should reset reconnect attempts on successful connection', async () => {
      mockConnect
        .mockRejectedValueOnce(new Error('First fail'))
        .mockRejectedValueOnce(new Error('Second fail'))
        .mockResolvedValueOnce(undefined);

      await dbEvents.start();

      // advanceTimersByTimeAsync flushes the promise chain between timer
      // firings; start() now awaits several queries before resetting the
      // counter, so plain advanceTimersByTime + a couple of microtask flushes
      // would settle too early and leave reconnectAttempts non-zero.
      await jest.advanceTimersByTimeAsync(2000); // first reconnect (still fails)
      await jest.advanceTimersByTimeAsync(4000); // second reconnect (succeeds)

      const status = dbEvents.getStatus();
      expect(status.reconnectAttempts).toBe(0);
    });

    it('should not reconnect during shutdown', async () => {
      await dbEvents.start();
      
      const endHandler = getHandler('end');

      await dbEvents.stop();
      jest.clearAllMocks();

      endHandler!();

      expect(logger.info).not.toHaveBeenCalledWith(
        'DB Events: Scheduling reconnect',
        expect.any(Object)
      );
    });
  });

  describe('unexpected disconnect handling', () => {
    beforeEach(async () => {
      await dbEvents.start();
    });

    it('should reconnect when connection ends unexpectedly', () => {
      const endHandler = getHandler('end');

      endHandler!();

      expect(logger.warn).toHaveBeenCalledWith(
        'DB Events: Connection ended unexpectedly - will reconnect'
      );
    });

    it('should not reconnect when shutdown is initiated', async () => {
      const endHandler = getHandler('end');

      await dbEvents.stop();
      jest.clearAllMocks();

      endHandler!();

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('should gracefully close connection', async () => {
      await dbEvents.start();
      await dbEvents.stop();

      expect(mockEnd).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('DB Events Listener stopped');
    });

    it('should clear reconnect timeout', async () => {
      mockConnect.mockRejectedValueOnce(new Error('Connection failed'));
      
      await dbEvents.start();
      await dbEvents.stop();

      jest.advanceTimersByTime(10000);
      await Promise.resolve();

      const connectCallCount = mockConnect.mock.calls.length;
      expect(connectCallCount).toBe(1);
    });

    it('should handle errors during shutdown', async () => {
      await dbEvents.start();
      mockEnd.mockRejectedValueOnce(new Error('Shutdown error'));

      await dbEvents.stop();

      expect(logger.error).toHaveBeenCalledWith(
        'DB Events: Error during shutdown',
        expect.objectContaining({ error: 'Shutdown error' })
      );
    });

    it('should be idempotent', async () => {
      await dbEvents.start();
      await dbEvents.stop();
      
      jest.clearAllMocks();
      await dbEvents.stop();

      expect(mockEnd).not.toHaveBeenCalled();
    });
  });

  describe('getStatus()', () => {
    it('should return connected status when client is active', async () => {
      await dbEvents.start();

      const status = dbEvents.getStatus();

      expect(status.connected).toBe(true);
      expect(status.reconnectAttempts).toBe(0);
    });

    it('should return disconnected status when client is not initialized', () => {
      const status = dbEvents.getStatus();

      expect(status.connected).toBe(false);
    });

    it('should track reconnect attempts', async () => {
      mockConnect.mockRejectedValue(new Error('Connection failed'));

      await dbEvents.start();
      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      const status = dbEvents.getStatus();
      expect(status.reconnectAttempts).toBeGreaterThan(0);
    });
  });
});
