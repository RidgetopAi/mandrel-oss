/**
 * Real-time Git Tracking Service for AIDIS
 * 
 * Monitors git activity during active sessions and automatically
 * triggers correlation when commits are detected.
 * 
 * Features:
 * - File system monitoring for .git directory changes
 * - Periodic polling for recent commits
 * - Automatic session-commit correlation
 * - Background processing for minimal performance impact
 */

import { watchFile, unwatchFile, existsSync } from 'fs';
import { join } from 'path';
import { GitCorrelationService } from './gitCorrelation.js';
import { getCurrentSession } from './session/SessionTracker.js';
import { db } from '../config/database.js';
import { logEvent } from '../middleware/eventLogger.js';
import { logger } from '../utils/logger.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { monitoring } from '../utils/monitoring.js';
import { unrefTimer } from '../utils/unrefTimer.js';

/**
 * A4 FIX (the auditor review §3.A) — actor-safe session resolution for gitTracker.
 *
 * gitTracker is a BACKGROUND singleton (file watcher + poller) with NO actor and NO connection
 * of its own. It used `getCurrentSession()` — the GLOBAL "most recent open session anywhere"
 * fallback — to attribute git commits to a session. With multiple concurrent actors (the coordinator +
 * Builders + tick), that attributes a commit to whoever's session happens to be newest: a live
 * CROSS-ACTOR MISATTRIBUTION on a write-adjacent path. The honest resolution for an actorless
 * background process is "attribute to nothing" — never cross-actor.
 *
 * FLAG-GATED so Phase 2a stays INERT by default (SESSION_CONFIG.resolverMode):
 *   'legacy' (DEFAULT) — unchanged: the global fallback. Byte-identical to before Phase 2a.
 *   'shadow'           — ACT ON LEGACY (global fallback) but ALSO record what the actor-safe
 *                        resolution would do (always "nothing", since there is no actor) and
 *                        emit the shadow counters labelled site=gitTracker. Measures how often
 *                        gitTracker WOULD have misattributed, with zero behavior change.
 *   'actor'            — actor-safe end state (2b): attribute to NOTHING (return null). gitTracker
 *                        has no actor, so it never claims another actor's session.
 */
export async function resolveSessionForGitTracker(): Promise<string | null> {
  const mode = SESSION_CONFIG.resolverMode;
  if (mode === 'legacy') {
    return getCurrentSession();
  }

  // The actor-safe resolution for an actorless background process: nothing.
  const actorSafe: string | null = null;

  if (mode === 'shadow') {
    const legacy = await getCurrentSession();
    const agree = legacy === actorSafe; // agree only when legacy also found nothing
    monitoring.incrementCounter(
      agree ? 'sessions_resolver_shadow_agree' : 'sessions_resolver_shadow_disagree',
      { site: 'gitTracker' }
    );
    if (!agree) {
      logger.warn(
        `🕶️  resolver shadow (gitTracker): DISAGREE — legacy global fallback would attribute git ` +
          `activity to session ${legacy?.substring(0, 8)}..., actor-safe resolution attributes to ` +
          `NOTHING (no actor). Acting on legacy in shadow mode.`,
        { metadata: { event: 'resolver_shadow_disagree', site: 'gitTracker', legacySessionId: legacy } }
      );
    }
    return legacy; // act on legacy in shadow mode
  }

  // mode === 'actor' (2b end state): never cross-actor — attribute to nothing.
  return actorSafe;
}

export interface GitTrackingConfig {
  enableFileWatching: boolean;
  enablePeriodicPolling: boolean;
  pollingIntervalMs: number;
  correlationDelayMs: number;
  maxRecentCommitsCheck: number;
}

export interface GitTrackingStatus {
  isActive: boolean;
  currentSession?: string;
  projectPath?: string;
  lastCheckTime: Date;
  commitsDetected: number;
  correlationsTriggered: number;
  watchers: string[];
}

const DEFAULT_CONFIG: GitTrackingConfig = {
  enableFileWatching: true,
  enablePeriodicPolling: true,
  pollingIntervalMs: 30000, // 30 seconds
  correlationDelayMs: 5000,  // 5 seconds delay after commit detection
  maxRecentCommitsCheck: 5   // Check for commits in last 5 minutes
};

/**
 * Real-time Git Tracking Service
 */
export class GitTracker {
  private static instance: GitTracker | null = null;
  private config: GitTrackingConfig;
  private isRunning: boolean = false;
  private pollingTimer: NodeJS.Timeout | null = null;
  private watchers: Map<string, () => void> = new Map();
  private status: GitTrackingStatus;

  private constructor(config: Partial<GitTrackingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.status = {
      isActive: false,
      lastCheckTime: new Date(),
      commitsDetected: 0,
      correlationsTriggered: 0,
      watchers: []
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<GitTrackingConfig>): GitTracker {
    if (!GitTracker.instance) {
      GitTracker.instance = new GitTracker(config);
    }
    return GitTracker.instance;
  }

  /**
   * Start real-time git tracking
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.info('⚡ Git tracker already running');
      return;
    }

    try {
      logger.info('🚀 Starting real-time git tracking...');
      
      this.isRunning = true;
      this.status.isActive = true;
      this.status.lastCheckTime = new Date();

      // Start file watching if enabled
      if (this.config.enableFileWatching) {
        await this.startFileWatching();
      }

      // Start periodic polling if enabled
      if (this.config.enablePeriodicPolling) {
        await this.startPeriodicPolling();
      }

      // Log tracking start
      await logEvent({
        actor: 'system',
        event_type: 'git_tracking_started',
        status: 'open',
        metadata: {
          fileWatching: this.config.enableFileWatching,
          periodicPolling: this.config.enablePeriodicPolling,
          pollingInterval: this.config.pollingIntervalMs
        },
        tags: ['git', 'tracking', 'realtime']
      });

      logger.info('✅ Git tracking started successfully');

    } catch (error) {
      logger.error('❌ Failed to start git tracking', error as Error);
      this.isRunning = false;
      this.status.isActive = false;
      throw error;
    }
  }

  /**
   * Stop real-time git tracking
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.info('⚡ Git tracker not running');
      return;
    }

    try {
      logger.info('🛑 Stopping real-time git tracking...');

      this.isRunning = false;
      this.status.isActive = false;

      // Stop periodic polling
      if (this.pollingTimer) {
        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
      }

      // Stop file watching
      await this.stopFileWatching();

      // Log tracking stop
      await logEvent({
        actor: 'system',
        event_type: 'git_tracking_stopped',
        status: 'closed',
        metadata: {
          commitsDetected: this.status.commitsDetected,
          correlationsTriggered: this.status.correlationsTriggered,
          totalWatchers: this.watchers.size
        },
        tags: ['git', 'tracking', 'realtime']
      });

      logger.info('✅ Git tracking stopped successfully');

    } catch (error) {
      logger.error('❌ Failed to stop git tracking', error as Error);
      throw error;
    }
  }

  /**
   * Get current tracking status
   */
  getStatus(): GitTrackingStatus {
    return {
      ...this.status,
      watchers: Array.from(this.watchers.keys())
    };
  }

  /**
   * Check for recent git activity
   */
  async checkForRecentActivity(): Promise<{
    hasActivity: boolean;
    newCommits: number;
    correlationTriggered: boolean;
  }> {
    try {
      // Get current session
      const sessionId = await resolveSessionForGitTracker();
      if (!sessionId) {
        return {
          hasActivity: false,
          newCommits: 0,
          correlationTriggered: false
        };
      }

      // Get session project (single consolidated `sessions` table)
      const sessionQuery = `
        SELECT project_id FROM sessions WHERE id = $1
      `;
      const sessionResult = await db.query(sessionQuery, [sessionId]);
      
      if (sessionResult.rows.length === 0 || !sessionResult.rows[0].project_id) {
        return {
          hasActivity: false,
          newCommits: 0,
          correlationTriggered: false
        };
      }

      // Check for new commits via real-time git activity tracking
      const result = await this.trackRealtimeGitActivity();
      
      this.status.lastCheckTime = new Date();

      if (result.recentCommits > 0) {
        logger.info(`⚡ Detected ${result.recentCommits} recent commits`);
        this.status.commitsDetected += result.recentCommits;
        
        if (result.autoCorrelated) {
          this.status.correlationsTriggered++;
        }

        return {
          hasActivity: true,
          newCommits: result.recentCommits,
          correlationTriggered: result.autoCorrelated
        };
      }

      return {
        hasActivity: false,
        newCommits: 0,
        correlationTriggered: false
      };

    } catch (error) {
      logger.error('❌ Error checking git activity', error as Error);
      return {
        hasActivity: false,
        newCommits: 0,
        correlationTriggered: false
      };
    }
  }

  /**
   * Real-time git tracking - detect recent commits during active session
   * and auto-correlate them. (Previously GitHandler.trackRealtimeGitActivity;
   * inlined here when the dormant git MCP tool handlers were removed.)
   */
  private async trackRealtimeGitActivity(): Promise<{
    success: boolean;
    sessionId?: string;
    recentCommits: number;
    autoCorrelated: boolean;
    error?: string;
  }> {
    try {
      logger.info('⚡ Checking for real-time git activity...');

      // Get current active session
      const sessionId = await resolveSessionForGitTracker();
      if (!sessionId) {
        return {
          success: true,
          recentCommits: 0,
          autoCorrelated: false,
          error: 'No active session - git tracking inactive'
        };
      }

      // Get session project (single consolidated `sessions` table)
      const sessionQuery = `
        SELECT project_id, started_at
        FROM sessions WHERE id = $1
      `;
      const sessionResult = await db.query(sessionQuery, [sessionId]);

      if (sessionResult.rows.length === 0 || !sessionResult.rows[0].project_id) {
        return {
          success: true,
          sessionId,
          recentCommits: 0,
          autoCorrelated: false,
          error: 'Session not assigned to project'
        };
      }

      const session = sessionResult.rows[0];

      // Check for commits in the last 5 minutes
      const recentCommitsResult = await GitCorrelationService.getRecentCommits({
        project_id: session.project_id,
        hours: 0.083, // 5 minutes
      });

      if (recentCommitsResult.commits.length > 0) {
        logger.info(`🔄 Found ${recentCommitsResult.commits.length} recent commits, triggering auto-correlation`);

        // Auto-correlate recent commits
        await GitCorrelationService.correlateSessionWithGit(sessionId);

        return {
          success: true,
          sessionId,
          recentCommits: recentCommitsResult.commits.length,
          autoCorrelated: true
        };
      }

      return {
        success: true,
        sessionId,
        recentCommits: 0,
        autoCorrelated: false
      };

    } catch (error) {
      logger.error('❌ Real-time git tracking error', error as Error);
      return {
        success: false,
        recentCommits: 0,
        autoCorrelated: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Start file system watching for git changes
   */
  private async startFileWatching(): Promise<void> {
    try {
      // Get current session and project
      const sessionId = await resolveSessionForGitTracker();
      if (!sessionId) {
        logger.info('📁 No active session - skipping file watching');
        return;
      }

      // Get project root directory (single consolidated `sessions` table)
      const sessionQuery = `
        SELECT p.root_directory, p.metadata->>'git_repo_path' as git_path
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.id = $1
      `;
      
      const result = await db.query(sessionQuery, [sessionId]);
      if (result.rows.length === 0) {
        logger.info('📁 Session not assigned to project - skipping file watching');
        return;
      }

      const projectData = result.rows[0];
      const projectPath = projectData.git_path || projectData.root_directory;
      
      if (!projectPath) {
        logger.info('📁 No project path found - skipping file watching');
        return;
      }

      this.status.projectPath = projectPath;

      // Watch key git files
      const gitFilesToWatch = [
        join(projectPath, '.git', 'HEAD'),
        join(projectPath, '.git', 'index'),
        join(projectPath, '.git', 'refs', 'heads'),
        join(projectPath, '.git', 'logs', 'HEAD')
      ];

      for (const filePath of gitFilesToWatch) {
        if (existsSync(filePath)) {
          try {
            const watchCallback = () => this.onGitFileChange(filePath);
            watchFile(filePath, { interval: 1000 }, watchCallback);
            this.watchers.set(filePath, () => unwatchFile(filePath, watchCallback));
            logger.info(`👀 Watching: ${filePath}`);
          } catch (error) {
            logger.warn(`⚠️  Failed to watch ${filePath}`, { metadata: { error } });
          }
        }
      }

      logger.info(`📁 Started file watching for ${this.watchers.size} git files`);

    } catch (error) {
      logger.error('❌ Failed to start file watching', error as Error);
    }
  }

  /**
   * Stop file system watching
   */
  private async stopFileWatching(): Promise<void> {
    try {
      for (const [filePath, stopWatcher] of this.watchers) {
        try {
          stopWatcher();
          logger.info(`👁️  Stopped watching: ${filePath}`);
        } catch (error) {
          logger.warn(`⚠️  Failed to stop watching ${filePath}`, { metadata: { error } });
        }
      }
      
      this.watchers.clear();
      logger.info('📁 Stopped all file watchers');

    } catch (error) {
      logger.error('❌ Failed to stop file watching', error as Error);
    }
  }

  /**
   * Start periodic polling for git changes
   */
  private async startPeriodicPolling(): Promise<void> {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
    }

    // unref'd. This poller is config-disabled today — backgroundServices
    // passes enablePeriodicPolling:false — and it is fixed anyway, because a config flip is
    // not a code review and must not be able to reintroduce a hang.
    this.pollingTimer = unrefTimer(setInterval(async () => {
      if (this.isRunning) {
        await this.checkForRecentActivity();
      }
    }, this.config.pollingIntervalMs));

    logger.info(`⏰ Started periodic polling every ${this.config.pollingIntervalMs}ms`);
  }

  /**
   * Handle git file change event
   */
  private async onGitFileChange(filePath: string): Promise<void> {
    try {
      logger.info(`📝 Git file changed: ${filePath}`);

      // Add small delay to allow git operation to complete
      await new Promise(resolve => setTimeout(resolve, this.config.correlationDelayMs));

      // Check for recent activity
      const activity = await this.checkForRecentActivity();
      
      if (activity.hasActivity) {
        logger.info(`⚡ Git file change triggered correlation: ${activity.newCommits} commits`);
        
        // Log the file change event
        await logEvent({
          actor: 'system',
          event_type: 'git_file_change_detected',
          status: 'closed',
          metadata: {
            filePath,
            newCommits: activity.newCommits,
            correlationTriggered: activity.correlationTriggered
          },
          tags: ['git', 'tracking', 'file_change']
        });
      }

    } catch (error) {
      logger.error(`❌ Error handling git file change for ${filePath}`, error as Error);
    }
  }

  /**
   * Force trigger correlation for current session
   */
  async forceCorrelation(): Promise<{
    success: boolean;
    sessionId?: string;
    linksCreated: number;
    message: string;
  }> {
    try {
      const sessionId = await resolveSessionForGitTracker();
      if (!sessionId) {
        return {
          success: false,
          linksCreated: 0,
          message: 'No active session found'
        };
      }

      logger.info(`🔗 Force triggering correlation for session: ${sessionId.substring(0, 8)}...`);

      const result = await GitCorrelationService.correlateSessionWithGit(sessionId);
      
      if (result.success) {
        this.status.correlationsTriggered++;
      }

      return {
        success: result.success,
        sessionId,
        linksCreated: result.linksCreated,
        message: result.message
      };

    } catch (error) {
      logger.error('❌ Force correlation failed', error as Error);
      return {
        success: false,
        linksCreated: 0,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

/**
 * Utility functions for external usage
 */

/**
 * Start git tracking (singleton)
 */
export async function startGitTracking(config?: Partial<GitTrackingConfig>): Promise<void> {
  const tracker = GitTracker.getInstance(config);
  await tracker.start();
}

/**
 * Stop git tracking
 */
export async function stopGitTracking(): Promise<void> {
  const tracker = GitTracker.getInstance();
  await tracker.stop();
}

/**
 * Get git tracking status
 */
export function getGitTrackingStatus(): GitTrackingStatus {
  const tracker = GitTracker.getInstance();
  return tracker.getStatus();
}

/**
 * Check for recent git activity
 */
export async function checkGitActivity(): Promise<{
  hasActivity: boolean;
  newCommits: number;
  correlationTriggered: boolean;
}> {
  const tracker = GitTracker.getInstance();
  return await tracker.checkForRecentActivity();
}

/**
 * Force correlation for current session
 */
export async function forceGitCorrelation(): Promise<{
  success: boolean;
  sessionId?: string;
  linksCreated: number;
  message: string;
}> {
  const tracker = GitTracker.getInstance();
  return await tracker.forceCorrelation();
}

/**
 * Export the main class
 */
export default GitTracker;