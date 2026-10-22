/**
 * Navigation SPINE route — resolve a bare id to its record and redirect.
 *
 * GET /api/r/:id  (also mounted at /r/:id server-side, see server.ts)
 *   ?project_id=<uuid>   optional — scope resolution to one project
 *
 * Given a bare id (full UUID or 8+-hex short id) this discovers which navigable
 * record type it is — context / task / decision / session / project, the population
 * enumerated by utils/idResolver.RESOLVABLE_TYPES — and:
 *   - unique match  → 302 redirect to the frontend detail page (/<type>s/<uuid>, or
 *                     /punch/<uuid> when the matched task carries a punch contract —
 *                     see urlForRecord in utils/idResolver.ts).
 *   - ambiguous     → 409 with the candidate list (NEVER silently picks one), which
 *                     includes a prefix collision ACROSS types (e.g. session+task).
 *   - not found     → 404 that NAMES the population searched + whether a project
 *                     scope narrowed it — never a bare 404.
 *   - malformed id  → 400 that names which shape rule was broken.
 *
 * REACHABILITY: this router is mounted at `/r` under the API router (→ /api/r/:id),
 * which the prod nginx vhost already routes to backend:5000 (the vhost sends /api
 * to the backend and everything else to the SPA) — so a browser hitting
 * command.example.com/api/r/<id> works today with NO vhost change. It is ALSO
 * mounted server-side at top-level /r (server.ts) so the literal /r/:id works when
 * the backend is hit directly (dev, or after a future vhost rule / SPA shim routes
 * the pretty /r/<id> short link — Feature A owns that frontend wiring).
 *
 * AUTH: consistent with the app's other record endpoints (decisions/tasks/contexts
 * all `authenticateToken`) — resolution requires a logged-in user. The SPA calls
 * this with its bearer token and follows the redirect / renders the disambiguation.
 *
 * Ambiguity uses 409 (Conflict) rather than a 3xx: a 3xx with a Location would be
 * a silent pick, and one without Location is easily mangled by proxies — a JSON 409
 * with the candidate list is the unambiguous fail-closed "you must choose" signal.
 */

import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/auth';
import { resolveListScope } from '../services/projectListScope';
import { logger } from '../config/logger';
import {
  resolveNavId,
  InvalidNavIdError,
  NavIdNotFoundError,
  AmbiguousNavIdError,
} from '../utils/idResolver';

const router = Router();

router.get('/:id', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    // Authorized upstream by projectContextMiddleware; mounted on both
    // /api and the top-level /r so this handler is covered on either path.
    //
    // INSIDE the try deliberately: getRequestProjectId THROWS when the middleware was not
    // mounted, and an async handler that throws OUTSIDE a try produces an unhandled
    // rejection — the request then hangs until the client times out instead of failing.
    // A fail-loud check that fails SILENTLY-SLOWLY is worse than the bug it reports.
    // UNSCOPED MEANS "THE CALLER'S PROJECTS", NEVER "EVERY PROJECT".
    // This was `getRequestProjectId(req)` — undefined when the request named no project,
    // which resolveNavId read as "search every table cross-project". A zero-grant
    // non-admin therefore resolved any id on the box; even the 302 discloses that the id
    // exists and what KIND of record it is, which is why the answer is a scoped MISS
    // (the existing NavIdNotFoundError -> 404 path) rather than a 403: a 403 here would
    // itself confirm the id is real.
    const scope = await resolveListScope(req as AuthenticatedRequest);
    const record = await resolveNavId(id, { scope });
    // Unique match — redirect to the frontend detail page. 302 (default) so the
    // method stays GET and clients treat it as a temporary navigation.
    res.redirect(302, record.url);
  } catch (error) {
    if (error instanceof InvalidNavIdError) {
      res.status(400).json({
        success: false,
        error: 'Invalid id',
        // `detail` names the rule that was broken (empty / not-hex / too-short) —
        // "invalid" alone gives a user nothing to act on.
        message: `"${id}" is not a full UUID or a valid short id. ${error.detail}`,
        reason: error.reason,
      });
      return;
    }
    if (error instanceof NavIdNotFoundError) {
      // NOT a bare 404: say what was searched and whether a project scope narrowed
      // it, so the user can tell "no such record" from "wrong project". The type
      // list comes from the resolver's own enumeration, so this sentence can never
      // claim a population the query did not search.
      res.status(404).json({
        success: false,
        error: 'Not found',
        message: `No record matches id "${id}". ${error.detail}`,
        searchedTypes: error.searchedTypes,
        projectScoped: error.projectScoped,
      });
      return;
    }
    if (error instanceof AmbiguousNavIdError) {
      // Fail-closed: return every candidate for the caller to disambiguate. We do
      // NOT redirect — never silently pick one of several matches.
      res.status(409).json({
        success: false,
        error: 'Ambiguous id',
        message: `Id "${id}" matches ${error.candidates.length} records. Re-navigate with the full id of the one you mean.`,
        ambiguous: true,
        candidates: error.candidates,
      });
      return;
    }
    // Unexpected (e.g. DB error) — 500, never a guessed redirect.
    logger.error('Nav id resolve error', { error, id });
    res.status(500).json({
      success: false,
      error: 'Resolve failed',
      message: 'Failed to resolve id.',
    });
  }
});

export default router;
