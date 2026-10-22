/**
 * Navigation JSON resolve route — resolve a bare id to its record as JSON.
 *
 * GET /api/resolve/:id
 *   ?project_id=<uuid>   optional — scope resolution to one project
 *
 * WHY THIS EXISTS (separate from the /r/:id 302 route): the in-UI interlinking
 * layer (Feature C) needs to resolve a bare id via `fetch`/axios and then perform
 * a CLIENT-SIDE navigation (react-router) so the record opens in the SAME tab. A
 * 302 redirect (what /r/:id returns) cannot be cleanly read by fetch — the browser
 * transparently follows it and the caller only sees the final page's body/URL, not
 * the resolved {type,id,url}. So this endpoint returns the SAME resolution as a JSON
 * body the SPA can read and act on:
 *   - unique match  → 200 { type, id, title, url } — type is any of
 *                     utils/idResolver.RESOLVABLE_TYPES (context/task/decision/
 *                     session/project)
 *   - ambiguous     → 409 { candidates } (NEVER silently picks one)
 *   - not found     → 404 { message, searchedTypes, projectScoped } — the SPA
 *                     renders `message`, so the user is told what was searched
 *   - malformed id  → 400 { message, reason }
 *
 * SINGLE SOURCE OF RESOLUTION (a past incident — fix the class, don't drift N copies):
 * this handler calls the EXACT SAME resolveNavId() as routes/resolve.ts. The ONLY
 * difference is the response SHAPE (a JSON body vs a 302 Location). The id-shape
 * validation, cross-type UNION query, project scoping, and fail-closed ambiguity
 * handling all live in utils/idResolver — there is no duplicated resolution logic.
 *
 * AUTH: same authenticateToken as every other record endpoint — resolution requires
 * a logged-in user; the SPA calls this with its bearer token.
 *
 * PROJECT SCOPE: cross-project by default (navigation must be able to follow a link
 * to a record in ANOTHER project), matching routes/resolve.ts and the existing
 * single-record GET endpoints. An explicit ?project_id narrows it.
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
    // Unique match — return the resolved record as JSON for the SPA to navigate to.
    res.status(200).json({
      success: true,
      type: record.type,
      id: record.id,
      title: record.title,
      url: record.url,
    });
  } catch (error) {
    // Both failure bodies mirror routes/resolve.ts exactly (same `detail` off the
    // same error object) — the SPA renders this message verbatim, so a user gets the
    // same explanation whether they hit the 302 route or the JSON one.
    if (error instanceof InvalidNavIdError) {
      res.status(400).json({
        success: false,
        error: 'Invalid id',
        message: `"${id}" is not a full UUID or a valid short id. ${error.detail}`,
        reason: error.reason,
      });
      return;
    }
    if (error instanceof NavIdNotFoundError) {
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
      // NOT pick one — the SPA renders the choice.
      res.status(409).json({
        success: false,
        error: 'Ambiguous id',
        message: `Id "${id}" matches ${error.candidates.length} records. Choose the one you mean.`,
        ambiguous: true,
        candidates: error.candidates,
      });
      return;
    }
    // Unexpected (e.g. DB error) — 500, never a guessed record.
    logger.error('Nav id JSON resolve error', { error, id });
    res.status(500).json({
      success: false,
      error: 'Resolve failed',
      message: 'Failed to resolve id.',
    });
  }
});

export default router;
