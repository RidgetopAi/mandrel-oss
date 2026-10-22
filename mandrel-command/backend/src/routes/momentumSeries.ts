import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { MomentumSeriesController } from '../controllers/momentumSeries';

const router = Router();

// All routes require authentication (UI-facing analytics surface).
router.use(authenticateToken);

/**
 * GET /momentum-series?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA>&project=<id|all>
 * Per-day Momentum (score + delta + headline counts) for every day in [from..to] — the
 * batch read that paints a momentum ring on each Calendar day cell before click-in
 *. Same shared formula + daily-series machinery as
 * the day-summary card, so a cell's score equals the card's score for that date.
 */
router.get('/', MomentumSeriesController.getMomentumSeries);

export default router;
