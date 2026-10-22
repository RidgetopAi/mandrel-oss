import { Queue, Worker, Job, QueueOptions, WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger.js';

/**
 * AIDIS Queue Manager
 * Replaces timer-based polling with proper queue system
 * Based on TR004-4 audit findings: Feature flags polling, git tracking, metrics collection
 */

// Redis connection is env-driven so it works both locally (localhost) and in
// containers (service hostname). Honors REDIS_URL, else REDIS_HOST/REDIS_PORT.
function resolveRedisHostPort(): { host: string; port: number } {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return { host: u.hostname, port: u.port ? parseInt(u.port, 10) : 6379 };
    } catch {
      // fall through to host/port vars
    }
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  };
}

const { host: REDIS_HOST, port: REDIS_PORT } = resolveRedisHostPort();

const REDIS_CONFIG = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null, // Required by BullMQ
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  connectTimeout: 10000,
  lazyConnect: true,
};

const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  connection: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: 50,  // Keep last 50 completed jobs
    removeOnFail: 100,     // Keep last 100 failed jobs for debugging
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
};

const DEFAULT_WORKER_OPTIONS: WorkerOptions = {
  connection: REDIS_CONFIG,
  concurrency: 1,  // Process one job at a time initially
};

export enum JobType {
  GIT_TRACKING = 'git-tracking',
  METRICS_COLLECTION = 'metrics-collection',
  COMPLEXITY_ANALYSIS = 'complexity-analysis',
  PATTERN_DETECTION = 'pattern-detection',
}

export interface QueueJobData {
  type: JobType;
  projectId?: string;
  sessionId?: string;
  config?: Record<string, any>;
  timestamp: number;
}

export class QueueManager {
  private queue: Queue;
  private workers: Map<JobType, Worker> = new Map();
  private redis: IORedis;
  private isShuttingDown = false;

  constructor(queueName = 'aidis-background-jobs') {
    this.redis = new IORedis(REDIS_CONFIG);
    this.queue = new Queue(queueName, DEFAULT_QUEUE_OPTIONS);

    // Setup error handling
    this.queue.on('error', (error) => {
      logger.error('[QueueManager] Queue error', error as Error);
    });

    this.redis.on('error', (error) => {
      logger.error('[QueueManager] Redis connection error', error as Error);
    });
  }

  /**
   * Initialize queue system and start workers
   */
  async initialize(): Promise<void> {
    try {
      await this.redis.ping();
      logger.info('[QueueManager] Redis connection established');

      // Register all job processors
      this.registerWorkers();

      // Drop schedules for job types this build no longer processes, BEFORE scheduling.
      await this.removeRetiredSchedules();

      // Schedule recurring jobs to replace timers
      await this.scheduleRecurringJobs();

      logger.info('[QueueManager] Queue system initialized');
    } catch (error) {
      logger.error('[QueueManager] Failed to initialize', error as Error);
      throw error;
    }
  }

  /**
   * Register worker processors for each job type
   */
  private registerWorkers(): void {
    // Git tracking worker (replaces 30s timer)
    this.createWorker(JobType.GIT_TRACKING, async (_job: Job<QueueJobData>) => {
      // TODO: Implement git tracking logic (currently timer-based in server.ts:4931)
      logger.info(`[QueueManager] Git tracking executed at ${new Date().toISOString()}`);
      return { success: true, timestamp: Date.now() };
    });

    // Metrics collection worker (replaces 5min timer)
    this.createWorker(JobType.METRICS_COLLECTION, async (_job: Job<QueueJobData>) => {
      // TODO: Implement metrics collection logic
      logger.info(`[QueueManager] Metrics collection executed at ${new Date().toISOString()}`);
      return { success: true, timestamp: Date.now() };
    });

    // Complexity analysis worker (replaces 10min timer)
    this.createWorker(JobType.COMPLEXITY_ANALYSIS, async (_job: Job<QueueJobData>) => {
      // TODO: Implement complexity analysis logic
      logger.info(`[QueueManager] Complexity analysis executed at ${new Date().toISOString()}`);
      return { success: true, timestamp: Date.now() };
    });

    // Pattern detection worker
    this.createWorker(JobType.PATTERN_DETECTION, async (_job: Job<QueueJobData>) => {
      // TODO: Implement pattern detection logic
      logger.info(`[QueueManager] Pattern detection executed at ${new Date().toISOString()}`);
      return { success: true, timestamp: Date.now() };
    });
  }

  /**
   * Create a worker for a specific job type
   */
  private createWorker(jobType: JobType, processor: (job: Job<QueueJobData>) => Promise<any>): void {
    const worker = new Worker(
      this.queue.name,
      async (job: Job<QueueJobData>) => {
        if (job.data.type === jobType) {
          return await processor(job);
        }
      },
      {
        ...DEFAULT_WORKER_OPTIONS,
        name: `${jobType}-worker`,
      }
    );

    worker.on('error', (error) => {
      logger.error(`[QueueManager] Worker ${jobType} error`, error as Error);
    });

    worker.on('failed', (job, error) => {
      logger.error(`[QueueManager] Job ${job?.id} (${jobType}) failed`, error as Error);
    });

    this.workers.set(jobType, worker);
  }

  /**
   * Job schedules this build no longer has a worker for.
   *
   * A BullMQ repeatable lives in REDIS, not in this file, so deleting the
   * `queue.add(..., { repeat })` call does NOT stop an already-registered schedule
   * on a running instance — it keeps enqueuing jobs that now have no processor, and
   * they pile up in `waiting` forever. Every instance in the fleet has a
   * `feature-flags-refresh` schedule registered against the deleted JSON
   * FeatureFlagStore, so the deletion is only complete once the
   * schedule is reaped on the next boot.
   *
   * Matched by JOB NAME, not by key. Measured against bullmq 5.78.0
   * (`node_modules/bullmq/dist/cjs/classes/queue.js`): `queue.add(name, data,
   * { repeat, jobId })` routes to `repeat.updateRepeatableJob(...)`, which stores the
   * entry under a COMPOSED key (name:jobId:endDate:tz:every), NOT under the `jobId`.
   * So `removeJobScheduler('feature-flags-refresh')` would have matched nothing and
   * logged nothing — a reaper that silently reaps nothing is worse than none, because
   * it reads as done. Enumerating and matching on `name` does not depend on knowing
   * how a given bullmq version composes its keys.
   */
  private static readonly RETIRED_JOB_SCHEDULES: readonly string[] = [
    // Retired by an earlier task along with utils/featureFlags.ts.
    'feature-flags-refresh',
  ];

  private async removeRetiredSchedules(): Promise<void> {
    const retired = new Set<string>(QueueManager.RETIRED_JOB_SCHEDULES);
    try {
      const repeatables = await this.queue.getRepeatableJobs();
      for (const entry of repeatables) {
        if (!retired.has(entry.name)) {
          continue;
        }
        await this.queue.removeRepeatableByKey(entry.key);
        logger.info(
          `[QueueManager] Removed retired job schedule '${entry.name}' (key ${entry.key})`
        );
      }
    } catch (error) {
      // Best-effort: a Redis hiccup here must not stop the server booting, and the only
      // consequence of a miss is that the reap retries on the next boot.
      logger.warn('[QueueManager] Could not reap retired job schedules', {
        metadata: { error: (error as Error).message },
      });
    }
  }

  /**
   * Schedule recurring jobs to replace timer-based polling
   */
  private async scheduleRecurringJobs(): Promise<void> {
    // Git tracking every 30 seconds
    await this.queue.add(
      JobType.GIT_TRACKING,
      {
        type: JobType.GIT_TRACKING,
        timestamp: Date.now(),
      },
      {
        repeat: { every: 30000 },
        jobId: 'git-tracking',
      }
    );

    // Metrics collection every 5 minutes
    await this.queue.add(
      JobType.METRICS_COLLECTION,
      {
        type: JobType.METRICS_COLLECTION,
        timestamp: Date.now(),
      },
      {
        repeat: { every: 300000 },
        jobId: 'metrics-collection',
      }
    );

    // Complexity analysis every 10 minutes
    await this.queue.add(
      JobType.COMPLEXITY_ANALYSIS,
      {
        type: JobType.COMPLEXITY_ANALYSIS,
        timestamp: Date.now(),
      },
      {
        repeat: { every: 600000 },
        jobId: 'complexity-analysis',
      }
    );

    logger.info('[QueueManager] Recurring jobs scheduled');
  }

  /**
   * Add a one-time job to the queue
   */
  async addJob(jobType: JobType, data: Partial<QueueJobData> = {}, options: any = {}): Promise<void> {
    const jobData: QueueJobData = {
      type: jobType,
      timestamp: Date.now(),
      ...data,
    };

    await this.queue.add(jobType, jobData, options);
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<any> {
    const waiting = await this.queue.getWaiting();
    const active = await this.queue.getActive();
    const completed = await this.queue.getCompleted();
    const failed = await this.queue.getFailed();
    const delayed = await this.queue.getDelayed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      workers: Array.from(this.workers.keys()),
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('[QueueManager] Shutting down...');

    // Close all workers
    for (const [jobType, worker] of this.workers) {
      try {
        await worker.close();
        logger.info(`[QueueManager] Worker ${jobType} closed`);
      } catch (error) {
        logger.error(`[QueueManager] Error closing worker ${jobType}`, error as Error);
      }
    }

    // Close queue
    try {
      await this.queue.close();
      logger.info('[QueueManager] Queue closed');
    } catch (error) {
      logger.error('[QueueManager] Error closing queue', error as Error);
    }

    // Close Redis connection
    try {
      await this.redis.quit();
      logger.info('[QueueManager] Redis connection closed');
    } catch (error) {
      logger.error('[QueueManager] Error closing Redis', error as Error);
    }
  }
}

// Singleton instance
let queueManager: QueueManager | null = null;

export async function getQueueManager(): Promise<QueueManager> {
  if (!queueManager) {
    queueManager = new QueueManager();
    await queueManager.initialize();
  }
  return queueManager;
}

export async function shutdownQueue(): Promise<void> {
  if (queueManager) {
    await queueManager.shutdown();
    queueManager = null;
  }
}