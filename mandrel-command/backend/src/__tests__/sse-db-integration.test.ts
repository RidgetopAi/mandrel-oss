/**
 * SSE Database Integration Tests
 * 
 * Tests the integration between database triggers, DbEvents listener, and SSE broadcasting
 * without relying on HTTP streaming (which is difficult to test with supertest)
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { sseService } from '../services/sse';
import { DbEvents } from '../services/dbEvents';
import { AidisDbEvent } from '../types/events';
import { describeDb } from './helpers/dbContractGate';

describeDb('SSE Database Integration', () => {
  let pool: Pool;
  let dbEvents: DbEvents;
  let testProjectId: string;
  const testContextIds: string[] = [];
  const testTaskIds: string[] = [];

  beforeAll(async () => {
    // Setup database connection
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    // Create test project
    testProjectId = uuidv4();
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO projects (id, name, description, status, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [testProjectId, 'SSE Integration Test Project', 'Test project for SSE integration tests', 'active']);
    } finally {
      client.release();
    }

    // Initialize DbEvents listener
    dbEvents = new DbEvents();
    await dbEvents.start();
    
    // Wait for connection to establish
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    // Cleanup test data
    const client = await pool.connect();
    try {
      // Delete contexts (will cascade)
      if (testContextIds.length > 0) {
        await client.query(`DELETE FROM contexts WHERE id = ANY($1)`, [testContextIds]);
      }
      
      // Delete tasks (will cascade)
      if (testTaskIds.length > 0) {
        await client.query(`DELETE FROM tasks WHERE id = ANY($1)`, [testTaskIds]);
      }
      
      // Delete test project
      await client.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
    } catch (error) {
      console.error('Cleanup error:', error);
    } finally {
      client.release();
    }

    await dbEvents.stop();
    await pool.end();
    sseService.disconnectAll();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Database Trigger to DbEvents Flow', () => {
    it('should receive database notification when context is inserted', (done) => {
      const contextId = uuidv4();
      testContextIds.push(contextId); // Track for cleanup
      let notificationReceived = false;

      // Spy on sseService.broadcastDbEvent
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO contexts (id, project_id, content, context_type, created_at)
            VALUES ($1, $2, $3, $4, NOW())
          `, [contextId, testProjectId, 'Test context', 'code']);
        } catch (error) {
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      // Check if broadcast was called within 3 seconds
      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const matchingCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === contextId && event.entity === 'contexts' && event.action === 'insert';
        });

        if (matchingCall) {
          notificationReceived = true;
        }

        broadcastSpy.mockRestore();
        expect(notificationReceived).toBe(true);
        done();
      }, 3000);
    }, 10000);

    it('should receive database notification when context is updated', (done) => {
      const contextId = uuidv4();
      testContextIds.push(contextId); // Track for cleanup
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          // Insert first
          await client.query(`
            INSERT INTO contexts (id, project_id, content, context_type, created_at)
            VALUES ($1, $2, $3, $4, NOW())
          `, [contextId, testProjectId, 'Original', 'code']);

          // Wait then update
          setTimeout(async () => {
            await client.query(`
              UPDATE contexts SET content = $1 WHERE id = $2
            `, ['Updated', contextId]);
          }, 1000);
        } catch (error) {
          broadcastSpy.mockRestore();
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      // Check for update event
      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const updateCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === contextId && event.action === 'update';
        });

        broadcastSpy.mockRestore();
        expect(updateCall).toBeDefined();
        done();
      }, 4000);
    }, 10000);

    it('should receive database notification when context is deleted', (done) => {
      const contextId = uuidv4();
      testContextIds.push(contextId); // Track for cleanup
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          // Insert first
          await client.query(`
            INSERT INTO contexts (id, project_id, content, context_type, created_at)
            VALUES ($1, $2, $3, $4, NOW())
          `, [contextId, testProjectId, 'To delete', 'code']);

          // Wait then delete
          setTimeout(async () => {
            await client.query(`DELETE FROM contexts WHERE id = $1`, [contextId]);
          }, 1000);
        } catch (error) {
          broadcastSpy.mockRestore();
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      // Check for delete event
      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const deleteCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === contextId && event.action === 'delete';
        });

        broadcastSpy.mockRestore();
        expect(deleteCall).toBeDefined();
        done();
      }, 4000);
    }, 10000);
  });

  describe('Database Triggers', () => {
    it('should have active database triggers for contexts table', async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT COUNT(*) as count
          FROM pg_trigger
          WHERE tgname LIKE '%notify%'
            AND tgrelid = 'contexts'::regclass
        `);
        
        expect(parseInt(result.rows[0].count)).toBeGreaterThan(0);
      } finally {
        client.release();
      }
    });

    it('should have active database triggers for tasks table', async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT COUNT(*) as count
          FROM pg_trigger
          WHERE tgname LIKE '%notify%'
            AND tgrelid = 'tasks'::regclass
        `);
        
        expect(parseInt(result.rows[0].count)).toBeGreaterThan(0);
      } finally {
        client.release();
      }
    });

    it('should have notify_aidis_change function defined', async () => {
      const client = await pool.connect();
      try {
        const result = await client.query(`
          SELECT COUNT(*) as count
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE p.proname = 'notify_aidis_change'
            AND n.nspname = 'public'
        `);
        
        expect(parseInt(result.rows[0].count)).toBeGreaterThan(0);
      } finally {
        client.release();
      }
    });
  });

  describe('DbEvents Service', () => {
    it('should be connected to database', () => {
      const status = dbEvents.getStatus();
      expect(status.connected).toBe(true);
    });

    it('should handle malformed notifications without crashing', async () => {
      const client = await pool.connect();
      try {
        // Send malformed notification - should not crash
        await client.query(`NOTIFY aidis_changes, 'invalid-json{'`);
        
        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Service should still be connected
        const status = dbEvents.getStatus();
        expect(status.connected).toBe(true);
      } finally {
        client.release();
      }
    });
  });

  describe('Task Database Integration', () => {
    it('should receive notification when task is created', (done) => {
      const taskId = uuidv4();
      testTaskIds.push(taskId); // Track for cleanup
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO tasks (id, project_id, title, type, priority, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
          `, [taskId, testProjectId, 'Test task', 'feature', 'high', 'todo']);
        } catch (error) {
          broadcastSpy.mockRestore();
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const matchingCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === taskId && event.entity === 'tasks' && event.action === 'insert';
        });

        broadcastSpy.mockRestore();
        expect(matchingCall).toBeDefined();
        done();
      }, 3000);
    }, 10000);

    it('should receive notification when task is updated', (done) => {
      const taskId = uuidv4();
      testTaskIds.push(taskId); // Track for cleanup
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          // Insert task
          await client.query(`
            INSERT INTO tasks (id, project_id, title, type, priority, status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
          `, [taskId, testProjectId, 'Task to update', 'feature', 'high', 'todo']);

          // Update task status
          setTimeout(async () => {
            await client.query(`
              UPDATE tasks SET status = $1 WHERE id = $2
            `, ['in_progress', taskId]);
          }, 1000);
        } catch (error) {
          broadcastSpy.mockRestore();
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const updateCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === taskId && event.action === 'update';
        });

        broadcastSpy.mockRestore();
        expect(updateCall).toBeDefined();
        done();
      }, 4000);
    }, 10000);
  });

  describe('Event Content Validation', () => {
    it('should include projectId in event when context has projectId', (done) => {
      const contextId = uuidv4();
      testContextIds.push(contextId); // Track for cleanup
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO contexts (id, project_id, content, context_type, created_at)
            VALUES ($1, $2, $3, $4, NOW())
          `, [contextId, testProjectId, 'Project test', 'code']);
        } catch (error) {
          broadcastSpy.mockRestore();
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const matchingCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === contextId;
        });

        if (matchingCall) {
          const event = matchingCall[0] as AidisDbEvent;
          expect(event.projectId).toBe(testProjectId);
        }

        broadcastSpy.mockRestore();
        expect(matchingCall).toBeDefined();
        done();
      }, 3000);
    }, 10000);

    it('should include timestamp in event', (done) => {
      const contextId = uuidv4();
      testContextIds.push(contextId); // Track for cleanup
      const broadcastSpy = jest.spyOn(sseService, 'broadcastDbEvent');

      setTimeout(async () => {
        const client = await pool.connect();
        try {
          await client.query(`
            INSERT INTO contexts (id, project_id, content, context_type, created_at)
            VALUES ($1, $2, $3, $4, NOW())
          `, [contextId, testProjectId, 'Timestamp test', 'code']);
        } catch (error) {
          broadcastSpy.mockRestore();
          done(error);
        } finally {
          client.release();
        }
      }, 500);

      setTimeout(() => {
        const calls = broadcastSpy.mock.calls;
        const matchingCall = calls.find(call => {
          const event = call[0] as AidisDbEvent;
          return event.id === contextId;
        });

        if (matchingCall) {
          const event = matchingCall[0] as AidisDbEvent;
          expect(event.at).toBeDefined();
          expect(typeof event.at).toBe('string');
        }

        broadcastSpy.mockRestore();
        expect(matchingCall).toBeDefined();
        done();
      }, 3000);
    }, 10000);
  });
});
