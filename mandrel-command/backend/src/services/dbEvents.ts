import { Client } from 'pg';
import config from '../config/environment';
import { logger } from '../config/logger';
import { sseService } from './sse';

/**
 * Database Events Listener Service
 * 
 * Listens to PostgreSQL NOTIFY events from database triggers and broadcasts
 * them to connected SSE clients via the SSE Service Hub.
 * 
 * Features:
 * - Dedicated PostgreSQL client for LISTEN
 * - Auto-reconnection on error with exponential backoff
 * - Parse NOTIFY payloads and broadcast to SSE clients
 * - Graceful shutdown support
 */
class DbEvents {
  private client?: Client;
  private reconnectTimeout?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // 30 seconds max
  private isShuttingDown = false;

  /**
   * Start the database events listener
   * Connects to PostgreSQL and listens to the aidis_changes channel
   */
  async start(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('DB Events Listener: Cannot start during shutdown');
      return;
    }

    // Reset shutdown flag for reconnections
    this.isShuttingDown = false;

    try {
      // Create dedicated PostgreSQL client
      this.client = new Client({
        user: config.database.user,
        host: config.database.host,
        database: config.database.database,
        password: config.database.password,
        port: config.database.port,
        application_name: 'aidis-db-events',
      });

      // Handle notification events (register BEFORE connect to avoid race)
      this.client.on('notification', (msg) => {
        try {
          if (!msg.payload) {
            logger.warn('DB Events: Received notification without payload', {
              channel: msg.channel
            });
            return;
          }

          const evt = JSON.parse(msg.payload);
          logger.debug('DB Events: Received notification', { 
            channel: msg.channel,
            event: evt 
          });
          
          // Broadcast to all connected SSE clients
          sseService.broadcastDbEvent(evt);
        } catch (error) {
          logger.warn('DB Events: Invalid NOTIFY payload', { 
            channel: msg.channel,
            payload: msg.payload,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      });

      // Add notice listener for debugging
      this.client.on('notice', (n) => logger.warn('PG notice', { 
        severity: n.severity, 
        message: n.message 
      }));

      await this.client.connect();
      await this.client.query("SET application_name TO 'aidis-db-events'");
      await this.client.query('UNLISTEN *');
      await this.client.query('LISTEN aidis_changes');
      
      // Verify LISTEN is active
      const { rows } = await this.client.query('SELECT array_agg(pg_listening_channels) as channels FROM pg_listening_channels()');
      
      // Reset reconnect attempts on successful connection
      this.reconnectAttempts = 0;

      logger.info('DB Events Listener started', { 
        channel: 'aidis_changes',
        database: config.database.database,
        host: config.database.host,
        channels: rows[0]?.channels || []
      });

      // Handle client errors
      this.client.on('error', async (err) => {
        logger.error('DB Events: LISTEN error - will reconnect', { 
          error: err.message,
          stack: err.stack 
        });
        await this.stop();
        this.scheduleReconnect();
      });

      // Handle unexpected client end
      this.client.on('end', () => {
        if (!this.isShuttingDown) {
          logger.warn('DB Events: Connection ended unexpectedly - will reconnect');
          this.scheduleReconnect();
        }
      });

    } catch (error) {
      logger.error('DB Events: Failed to start listener', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isShuttingDown) {
      return;
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, 30s (max)
    const delay = Math.min(
      2000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;

    logger.info('DB Events: Scheduling reconnect', { 
      attempt: this.reconnectAttempts,
      delayMs: delay 
    });

    this.reconnectTimeout = setTimeout(() => {
      this.start().catch((error) => {
        logger.error('DB Events: Reconnect failed', { 
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      });
    }, delay);
  }

  /**
   * Stop the database events listener
   * Gracefully closes the connection and clears reconnect timers
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    try {
      if (this.client) {
        await this.client.end();
        this.client = undefined;
        logger.info('DB Events Listener stopped');
      }
    } catch (error) {
      logger.error('DB Events: Error during shutdown', { 
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Get status of the DB Events Listener
   */
  getStatus(): { connected: boolean; reconnectAttempts: number } {
    return {
      connected: !!(this.client && !(this.client as any).ended),
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

export const dbEvents = new DbEvents();
export { DbEvents };