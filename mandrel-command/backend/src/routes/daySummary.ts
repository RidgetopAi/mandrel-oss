import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { DaySummaryController } from '../controllers/daySummary';

const router = Router();

// All routes require authentication (UI-facing report surface).
router.use(authenticateToken);

/**
 * GET /day-summary?date=YYYY-MM-DD&tz=<IANA>&project=<id|all>
 * Assembles the Calendar click-into-date DAY-SUMMARY report:
 * auto-headline, transparent momentum score, KPI tiles w/ deltas, 24h activity
 * ribbon, milestone/completion highlights, decisions, tasks completed, and a by-actor
 * breakdown — all TZ-correct per 100% wired to existing data.
 */
router.get('/', DaySummaryController.getDaySummary);

export default router;
