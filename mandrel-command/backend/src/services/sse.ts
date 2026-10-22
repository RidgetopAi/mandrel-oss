import { Response, Request } from 'express';
import { logger } from '../config/logger';
import { AidisDbEvent, AidisEntity } from '../types/events';
import type { SseScopedRequest } from '../middleware/sseAuth';

/**
 * SSE Client representation
 */
type Client = {
  res: Response;
  userId: string;
  entities?: Set<AidisEntity>;
  /** The project this client asked to filter to (optional, and only ever NARROWS). */
  projectId?: string;
  /**
   * The projects this client is AUTHORIZED to receive events for.
   * `null` = all projects (admin). Never undefined: handleSubscribe refuses the
   * subscription rather than defaulting, because the old default was "everything".
   */
  authorizedProjectIds: Set<string> | null;
  connectedAt: Date;
};

/**
 * SSE Service Hub
 * 
 * Manages Server-Sent Events connections and broadcasts database events
 * to connected clients with filtering support.
 * 
 * Features:
 * - Per-user connection tracking and limits
 * - Entity type filtering (contexts, tasks, decisions, etc.)
 * - Project ID filtering
 * - Automatic heartbeat to keep connections alive
 * - Event ID tracking for potential replay support
 * - Connection statistics and monitoring
 */
class SseService {
  private clients = new Set<Client>();
  private nextId = 1;
  private maxConnectionsPerUser = 5;
  private heartbeatInterval = 15000; // 15 seconds

  /**
   * Handle new SSE client subscription
   * Sets up SSE headers, filters, and heartbeat
   */
  handleSubscribe = (req: Request, res: Response): void => {
    const userId = (req as any).user?.id || 'unknown';
    
    // Check connection limit per user
    const userConnections = Array.from(this.clients).filter(c => c.userId === userId);
    if (userConnections.length >= this.maxConnectionsPerUser) {
      logger.warn('SSE: Too many connections for user', { 
        userId, 
        currentConnections: userConnections.length,
        maxAllowed: this.maxConnectionsPerUser 
      });
      res.status(503).send('Too many connections. Maximum ' + this.maxConnectionsPerUser + ' connections allowed per user.');
      return;
    }

    // Parse entity type filters from query param
    const entities = typeof req.query.entities === 'string'
      ? new Set((req.query.entities as string).split(',').filter(Boolean) as AidisEntity[])
      : undefined;
    
    // Project scope: resolved AND AUTHORIZED upstream (projectContextMiddleware →
    // middleware/sseAuth.ts:extractSseProjectContext). This deliberately does NOT read
    // req.query.projectId any more — that raw read was the un-authorized door.
    const projectId = (req as unknown as { project?: { id: string } }).project?.id;
    const authorizedProjectIds = (req as unknown as SseScopedRequest).sseAuthorizedProjectIds;
    if (authorizedProjectIds === undefined) {
      // Fail closed: extractSseProjectContext did not run. Never fall through to the old
      // "no filter = every project" behaviour.
      logger.error('SSE: subscription refused — authorized project set was never computed', { userId });
      res.status(500).send('Project authorization was not resolved for this connection');
      return;
    }

    // Validate entity types if provided
    if (entities && entities.size > 0) {
      const validEntities: AidisEntity[] = ['contexts', 'tasks', 'decisions', 'projects', 'sessions'];
      const invalidEntities = Array.from(entities).filter(e => !validEntities.includes(e));
      if (invalidEntities.length > 0) {
        logger.warn('SSE: Invalid entity types requested', { 
          userId, 
          invalidEntities 
        });
        res.status(400).send('Invalid entity types: ' + invalidEntities.join(', '));
        return;
      }
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevent nginx buffering
    res.flushHeaders();

    // Send retry hint to client (5 seconds)
    try {
      res.write('retry: 5000\n\n');
    } catch (error) {
      logger.warn('SSE: Failed to write retry hint', { 
        userId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return;
    }

    // Create client record
    const client: Client = {
      res,
      userId,
      entities,
      projectId,
      authorizedProjectIds,
      connectedAt: new Date()
    };
    this.clients.add(client);

    logger.info('SSE: Client connected', { 
      userId, 
      projectId, 
      entities: entities ? Array.from(entities) : 'all',
      totalConnections: this.clients.size
    });

    // Send initial connection confirmation
    this.writeEvent(client, 'system', { 
      message: 'connected', 
      userId,
      timestamp: new Date().toISOString()
    });

    // Heartbeat interval to keep connection alive
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(': keep-alive\n\n');
      } catch (error) {
        logger.warn('SSE: Heartbeat write failed', { userId });
        clearInterval(heartbeat);
        this.clients.delete(client);
      }
    }, this.heartbeatInterval);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(client);
      
      const connectionDuration = Date.now() - client.connectedAt.getTime();
      logger.info('SSE: Client disconnected', { 
        userId, 
        connectionDurationMs: connectionDuration,
        totalConnections: this.clients.size
      });
    });
  };

  /**
   * Broadcast database event to all eligible clients
   * Applies entity and project filtering
   */
  broadcastDbEvent = (evt: AidisDbEvent): void => {
    let sentCount = 0;
    let filteredCount = 0;

    for (const client of this.clients) {
      // Filter by entity type
      if (client.entities && !client.entities.has(evt.entity)) {
        filteredCount++;
        continue;
      }
      
      // ── AUTHORIZATION FILTER ─────────────────────────────────────
      // THE DECISION: a client that names NO project gets ITS OWN AUTHORIZED PROJECTS,
      // never "everything". Previously the only project filter was the optional
      // client-supplied one below, so an authenticated non-admin who simply omitted
      // ?projectId received the CROSS-PROJECT event stream (ids, entity, action — not
      // content, but a complete map of who is doing what, where).
      //
      // An event with NO projectId is UNATTRIBUTABLE, so a non-admin does not get it:
      // deny-by-default is the whole point, and "we could not tell which project this
      // belongs to" must not resolve to "send it" (C1 — the third state).
      // admin (authorizedProjectIds === null) is unchanged: all events.
      if (client.authorizedProjectIds !== null) {
        if (!evt.projectId || !client.authorizedProjectIds.has(evt.projectId)) {
          filteredCount++;
          continue;
        }
      }

      // Client-requested narrowing filter (only if both client and event have projectId)
      if (client.projectId && evt.projectId && client.projectId !== evt.projectId) {
        filteredCount++;
        continue;
      }
      
      this.writeEvent(client, evt.entity, evt);
      sentCount++;
    }

    if (sentCount > 0 || filteredCount > 0) {
      logger.debug('SSE: Broadcast complete', { 
        entity: evt.entity,
        action: evt.action,
        id: evt.id,
        sent: sentCount,
        filtered: filteredCount,
        total: this.clients.size
      });
    }
  };

  /**
   * Write SSE event to a specific client
   */
  private writeEvent(client: Client, eventName: string, data: unknown): void {
    const id = this.nextId++;
    try {
      client.res.write(`id: ${id}\n`);
      client.res.write(`event: ${eventName}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      logger.warn('SSE: Failed to write event', { 
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: client.userId,
        eventName
      });
      this.clients.delete(client);
    }
  }

  /**
   * Get SSE service statistics
   */
  getStats(): {
    totalConnections: number;
    connectionsByUser: Record<string, number>;
    nextEventId: number;
    uptimeSeconds: number;
  } {
    return {
      totalConnections: this.clients.size,
      connectionsByUser: this.getConnectionsByUser(),
      nextEventId: this.nextId,
      uptimeSeconds: process.uptime()
    };
  }

  /**
   * Get connection count grouped by user
   */
  private getConnectionsByUser(): Record<string, number> {
    const counts = new Map<string, number>();
    for (const client of this.clients) {
      counts.set(client.userId, (counts.get(client.userId) || 0) + 1);
    }
    return Object.fromEntries(counts);
  }

  /**
   * Get detailed client information (for debugging/monitoring)
   */
  getClients(): Array<{
    userId: string;
    projectId?: string;
    entities?: string[];
    connectedAt: string;
    connectionDurationMs: number;
  }> {
    return Array.from(this.clients).map(client => ({
      userId: client.userId,
      projectId: client.projectId,
      entities: client.entities ? Array.from(client.entities) : undefined,
      connectedAt: client.connectedAt.toISOString(),
      connectionDurationMs: Date.now() - client.connectedAt.getTime()
    }));
  }

  /**
   * Disconnect all clients (for graceful shutdown)
   */
  disconnectAll(): void {
    logger.info('SSE: Disconnecting all clients', { count: this.clients.size });
    
    for (const client of this.clients) {
      try {
        this.writeEvent(client, 'system', { 
          message: 'server-shutdown',
          timestamp: new Date().toISOString()
        });
        client.res.end();
      } catch (error) {
        // Ignore errors during shutdown
      }
    }
    
    this.clients.clear();
  }
}

export const sseService = new SseService();
