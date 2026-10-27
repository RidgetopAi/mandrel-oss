/**
 * Embedding Datasets
 * 
 * Get available embedding datasets for visualization.
 */

import { db } from '../../database/connection';
import { resolveProjectId } from './core';
import { logger } from '../../config/logger';
import type { EmbeddingScope, EmbeddingDataset } from './types';

/**
 * The explicit sentinel for "every project" (J3). A WORD, not `null`, so the unrestricted
 * mode cannot be reached by omitting an argument and is legible at the call site.
 *
 * ONE SENTINEL, ONE VALUE (Reviewer round 5). This module used to declare its own
 * `'all-projects'` while services/projectListScope.ts declared `'ALL_PROJECTS'`. Two
 * literals for one concept could not be MIXED UP today — the types are non-comparable, so
 * a swap is a compile error — but they are a rename hazard: the day someone widens either
 * type to `string`, the mistake becomes silent and it is the unrestricted mode that goes
 * wrong. Re-exported from the single declaration instead.
 */
export { ALL_PROJECTS } from '../projectListScope';
import { ALL_PROJECTS } from '../projectListScope';
// Lesson-011 class-fix: read the ACTIVE embedder's column (config), never hardcode `embedding`.
import { activeEmbeddingColumn, activeEmbeddingDimensions } from '../../config/embeddingColumn';

/**
 * Get available embedding datasets for a project
 */
export async function getAvailableDatasets(
  _userId: string,
  scope: EmbeddingScope = {},
  /**
   * The projects this caller may see — REQUIRED, with no default (J3).
   *
   * WHY: `/embedding/list` is the ONE route here that legitimately allows
   * an UNSCOPED request — the UI calls it with no project to populate the dataset picker.
   * Unscoped used to mean "every project on the box", so any authenticated non-admin got a
   * list of every project's name and context count.
   *
   * WHY REQUIRED, AND WHY `ALL_PROJECTS` IS A WORD (J3): this parameter used to default to
   * `null`, meaning "all projects". F1's entire mechanism was that the argument got DROPPED
   * at the call site and everything leaked — and a default of `null` is what made dropping
   * it catastrophic rather than merely wrong. A guard cannot defend a bad state that
   * omission reaches for free. There is now no default: forgetting the argument is a
   * COMPILE error, and the dangerous mode has to be spelled `ALL_PROJECTS` at the call
   * site, where a reviewer sees the word.
   */
  allowedProjectIds: readonly string[] | typeof ALL_PROJECTS
): Promise<EmbeddingDataset[]> {
  try {
    const resolvedProjectId = await resolveProjectId(scope);
    const col = activeEmbeddingColumn();
    const params: (string | string[])[] = [];
    let whereClause = `c.${col} IS NOT NULL`;

    if (resolvedProjectId) {
      params.push(resolvedProjectId);
      whereClause += ` AND c.project_id = $${params.length}`;
    } else if (allowedProjectIds !== ALL_PROJECTS) {
      // The EMPTY population matters and is the one that slips through a truthiness test:
      // a caller with zero grants must see NOTHING, not everything. `= ANY($n)` over an
      // empty array is legitimately empty, so this needs no special case — but it does
      // need to not be written as `if (allowedProjectIds.length)`.
      params.push([...allowedProjectIds]);
      whereClause += ` AND c.project_id = ANY($${params.length}::uuid[])`;
    }

    const query = `
      SELECT
        p.id::text AS id,
        p.name AS name,
        'Embeddings from stored project contexts' AS description,
        COUNT(*) AS count,
        -- DERIVED from the active embedder, never a literal (configs-not-hardcoded).
        -- This number is rendered by the Command UI as the dataset's dimensionality; it
        -- said 1536 while the fleet has written 768-d gemma vectors since the 2026-08-13
        -- cutover, so the UI has been reporting a dimension no stored row has. A trusted
        -- integer from the config registry (never user input) -> safe to interpolate.
        ${activeEmbeddingDimensions()} AS dimensions,
        MIN(c.created_at) AS created_at
      FROM contexts c
      JOIN projects p ON p.id = c.project_id
      WHERE c.archived_at IS NULL AND (${whereClause})
      GROUP BY p.id, p.name
      HAVING COUNT(*) > 0
      ORDER BY count DESC
      LIMIT 25
    `;

    const result = await db.query(query, params);

    return result.rows as EmbeddingDataset[];
  } catch (error) {
    logger.error('Error getting embedding datasets', { error });
    throw new Error('Failed to get embedding datasets');
  }
}
