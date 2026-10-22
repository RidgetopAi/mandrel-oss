import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import DashboardController from '../controllers/dashboard';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

/**
 * @swagger
 * /dashboard/stats:
 *   get:
 *     summary: Get dashboard statistics
 *     description: Returns aggregated statistics for the dashboard including contexts, tasks, and projects
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     contexts:
 *                       type: number
 *                       description: Total number of contexts
 *                     activeTasks:
 *                       type: number
 *                       description: Number of active tasks
 *                     totalTasks:
 *                       type: number
 *                       description: Total number of tasks
 *                     projects:
 *                       type: number
 *                       description: Total number of projects
 *                     recentActivity:
 *                       type: object
 *                       properties:
 *                         contextsThisWeek:
 *                           type: number
 *                           description: Number of contexts created this week
 *                         tasksCompletedThisWeek:
 *                           type: number
 *                           description: Number of tasks completed this week
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/stats', DashboardController.getDashboardStats);

export default router;
