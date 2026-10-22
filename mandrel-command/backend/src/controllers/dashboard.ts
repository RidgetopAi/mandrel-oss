import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { ContextService } from '../services/context';
import { TaskService } from '../services/task';
import { ProjectService } from '../services/project';
import { logger } from '../config/logger';
import { resolveListScope } from '../services/projectListScope';

export interface DashboardStats {
  contexts: number;
  activeTasks: number;
  totalTasks: number;
  projects: number;
  recentActivity: {
    contextsThisWeek: number;
    tasksCompletedThisWeek: number;
  };
}

class DashboardController {
  /**
   * GET /dashboard/stats - Get aggregated dashboard statistics
   * Oracle Phase 2: Real database counts using dedicated count methods
   */
  static async getDashboardStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // EVERY number on this card was global (an earlier task item 7): three of the four
      // calls took no project at all and the fourth took `req.projectId`, so an unscoped
      // non-admin read box-wide context/task/project counts.
      const scope = await resolveListScope(req);

      logger.info('🚀 Oracle Phase 2 Dashboard - Starting aggregation', { scope: scope.mode });

      // Oracle Phase 2: Use dedicated count methods for maximum efficiency
      const [
        contextCount,
        activeTaskCount,
        taskStats,
        projectStats
      ] = await Promise.all([
        ContextService.count(scope),
        TaskService.countActive(scope),
        TaskService.getTaskStats(scope),
        ProjectService.getProjectStats(scope)
      ]);

      // Build Oracle's dashboard stats response structure
      const dashboardStats: DashboardStats = {
        contexts: contextCount,                    // Real count from ContextService.count()
        activeTasks: activeTaskCount,              // Real count from TaskService.countActive()
        totalTasks: taskStats.total,
        projects: projectStats.total_projects,
        recentActivity: {
          contextsThisWeek: projectStats.recent_activity.contexts_last_week,
          tasksCompletedThisWeek: taskStats.by_status.completed || 0
        }
      };

      logger.info('📊 Oracle Phase 2 Dashboard - Final aggregation', {
        scope: scope.mode,
        contextCount,
        activeTaskCount,
        totalTasks: taskStats.total,
        projectCount: projectStats.total_projects,
        recentContexts: projectStats.recent_activity.contexts_last_week
      });

      res.json({
        success: true,
        data: dashboardStats
      });

    } catch (error) {
      logger.error('❌ Oracle Phase 2 Dashboard aggregation error', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to get dashboard statistics',
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export default DashboardController;
