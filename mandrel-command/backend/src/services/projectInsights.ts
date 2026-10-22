/**
 * Project Insights Service
 *
 * Provides real project metrics from direct database queries
 * - Tasks (total, completed, in progress, completion %)
 * - Contexts (knowledge base entries)
 * - Decisions (technical decisions)
 * - Git Activity (commits, insertions, deletions)
 */

import { db } from '../database/connection';

export interface TaskMetrics {
  total: number;
  completed: number;
  in_progress: number;
  todo: number;
  blocked: number;
  cancelled: number;
  completion_percentage: number;
}

export interface GitMetrics {
  total_commits: number;
  total_insertions: number;
  total_deletions: number;
  files_changed: number;
  latest_commit_date: string | null;
  latest_commit_message: string | null;
}

export interface ProjectInsights {
  project_id: string;
  project_name: string;
  tasks: TaskMetrics;
  contexts: {
    total: number;
  };
  decisions: {
    total: number;
  };
  git_activity: GitMetrics;
  generated_at: string;
}

export class ProjectInsightsService {

  /**
   * Get comprehensive project insights for a specific project
   */
  static async getProjectInsights(projectId: string): Promise<ProjectInsights> {
    const client = await db.connect();

    try {
      // Execute all queries in parallel for performance
      const [projectResult, tasksResult, contextsResult, decisionsResult, gitResult] = await Promise.all([
        // Get project name
        client.query(
          'SELECT name FROM projects WHERE id = $1',
          [projectId]
        ),

        // Get task metrics.
        //
        // LIVE ROWS ONLY. `archived_at IS NULL` is not optional here: since
        // the Command UI's Delete became a SOFT delete, a deleted task still EXISTS in this
        // table. Without this predicate every count below — and therefore
        // `completion_percentage`, rendered as a literal <Progress> bar in
        // frontend/src/components/analytics/ProjectInsights.tsx — would keep counting tasks
        // the user deleted, forever. The hard delete used to make that correct by accident.
        //
        // This must agree with TaskService.getTaskStats, which applies the same predicate.
        // The two totals are reconciled by taskSoftDelete.db.test.ts ("insights total agrees
        // with stats total after a soft delete"), so they cannot drift apart again silently.
        client.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE status = 'completed') as completed,
            COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
            COUNT(*) FILTER (WHERE status = 'todo') as todo,
            COUNT(*) FILTER (WHERE status = 'blocked') as blocked,
            COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
          FROM tasks
          WHERE project_id = $1
            AND archived_at IS NULL
        `, [projectId]),

        // Get context count
        client.query(
          'SELECT COUNT(*) as total FROM contexts WHERE project_id = $1',
          [projectId]
        ),

        // Get decision count
        client.query(
          'SELECT COUNT(*) as total FROM technical_decisions WHERE project_id = $1',
          [projectId]
        ),

        // Get git activity metrics
        client.query(`
          SELECT
            COUNT(*) as total_commits,
            COALESCE(SUM(insertions), 0) as total_insertions,
            COALESCE(SUM(deletions), 0) as total_deletions,
            COALESCE(SUM(files_changed), 0) as files_changed,
            MAX(committer_date) as latest_commit_date,
            (SELECT message FROM git_commits WHERE project_id = $1 ORDER BY committer_date DESC LIMIT 1) as latest_commit_message
          FROM git_commits
          WHERE project_id = $1
        `, [projectId])
      ]);

      // Extract project name
      const projectName = projectResult.rows[0]?.name || 'Unknown Project';

      // Extract task metrics
      const taskRow = tasksResult.rows[0];
      const totalTasks = parseInt(taskRow.total) || 0;
      const completedTasks = parseInt(taskRow.completed) || 0;
      const completionPercentage = totalTasks > 0
        ? Math.round((completedTasks / totalTasks) * 100)
        : 0;

      const taskMetrics: TaskMetrics = {
        total: totalTasks,
        completed: completedTasks,
        in_progress: parseInt(taskRow.in_progress) || 0,
        todo: parseInt(taskRow.todo) || 0,
        blocked: parseInt(taskRow.blocked) || 0,
        cancelled: parseInt(taskRow.cancelled) || 0,
        completion_percentage: completionPercentage
      };

      // Extract context count
      const contextTotal = parseInt(contextsResult.rows[0]?.total) || 0;

      // Extract decision count
      const decisionTotal = parseInt(decisionsResult.rows[0]?.total) || 0;

      // Extract git metrics
      const gitRow = gitResult.rows[0];
      const gitMetrics: GitMetrics = {
        total_commits: parseInt(gitRow.total_commits) || 0,
        total_insertions: parseInt(gitRow.total_insertions) || 0,
        total_deletions: parseInt(gitRow.total_deletions) || 0,
        files_changed: parseInt(gitRow.files_changed) || 0,
        latest_commit_date: gitRow.latest_commit_date || null,
        latest_commit_message: gitRow.latest_commit_message || null
      };

      return {
        project_id: projectId,
        project_name: projectName,
        tasks: taskMetrics,
        contexts: {
          total: contextTotal
        },
        decisions: {
          total: decisionTotal
        },
        git_activity: gitMetrics,
        generated_at: new Date().toISOString()
      };

    } finally {
      client.release();
    }
  }
}
