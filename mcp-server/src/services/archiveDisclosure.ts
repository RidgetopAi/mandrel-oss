/**
 * ARCHIVE DISCLOSURE service.
 *
 * Answers, for one entity in one project: "was this read narrowed by the soft-delete
 * default, and by how much?" — and renders the ONE line that says so.
 *
 * NO EMOJI IN THESE LINES. They ride READ surfaces, which ws1ResponseShape's D2 requires
 * to be emoji-free on the wire — the disclosure is payload, not decoration.
 *
 * SINGLE RENDERER, same rule as the trust band (trustExplainSingleRenderer.contract.test):
 * `renderArchiveDisclosure()` is the only place the disclosure sentence is composed. A
 * second site that hand-writes "N archived …" is a second copy of the vocabulary and will
 * drift from the structured block beside it. The guard enforces this.
 *
 * Rationale for disclosure-over-flipping-the-default, the three states, and the narrow
 * definition of `excludedCount` all live in config/archiveDisclosureConfig.ts, next to the
 * registry they govern.
 */

import {
  ARCHIVE_DISCLOSURE_KEY,
  disclosableTable,
  type ArchiveDisclosureState,
  type DisclosableEntity,
} from '../config/archiveDisclosureConfig.js';
import { logger } from '../utils/logger.js';

export interface ArchiveDisclosure {
  /** Which flag value produced this read. Echoed so the caller need not recall what it sent. */
  includeArchived: boolean;
  /** Tri-state. `none-archived` is a MEASURED zero and is not the same as `included`. */
  state: ArchiveDisclosureState;
  /**
   * Rows carrying `archived_at IS NOT NULL` in this project+table — the rows the archive
   * predicate withheld from consideration. NOT "results you would have received"; see
   * `scopeNote` and the config header.
   */
  excludedCount: number;
  /** The entity this is about, so a merged multi-entity response stays unambiguous. */
  entity: DisclosableEntity;
  /** States what the number is over, IN the response. The number never travels alone. */
  scopeNote: string;
}

const SCOPE_NOTE =
  'count of archived rows in this project excluded from consideration before query, ' +
  'ranking and limit — not a count of results withheld';
const SCOPE_NOTE_ALL_PROJECTS =
  'count of archived rows across ALL projects excluded from the per-project counts in this ' +
  'list — not a count of results withheld';

/**
 * Sentinel for an op whose counts span every project (project_list). Passed where a
 * projectId would go so the measurement is fleet-wide and the scopeNote says so.
 */
export const ALL_PROJECTS = Symbol('archiveDisclosure.allProjects');
export type DisclosureScope = string | typeof ALL_PROJECTS;

/**
 * Measure the archived population for one entity in one project and build the block.
 *
 * FAIL-LOUD, NOT FAIL-QUIET: if the count query throws, this returns null rather than a
 * zero. A zero here would be a fabricated measurement — the exact C1 third-state bug this
 * feature exists to close — so "could not measure" gets its own return value and the
 * caller omits the block instead of publishing a number nobody read.
 */
export async function measureArchiveDisclosure(
  queryFn: (sql: string, params: any[]) => Promise<{ rows: any[] }>,
  entity: DisclosableEntity,
  projectId: DisclosureScope | null | undefined,
  includeArchived: boolean
): Promise<ArchiveDisclosure | null> {
  if (!projectId) return null;

  const t = disclosableTable(entity);
  const allProjects = projectId === ALL_PROJECTS;
  let excludedCount: number;
  try {
    // PROJECT BY ID **OR NAME**. The route resolvers pass `args.projectId` through
    // untouched, so it reaches here as whichever the caller typed. A bare
    // `project_id = $1` throws on a name (invalid uuid), measureArchiveDisclosure would
    // catch it, and the disclosure would silently VANISH for every name-based call — a
    // feature that disappears exactly when a caller uses the friendlier spelling is worse
    // than one that was never added.
    //
    // SOFT-DELETE-EXEMPT: this query's ENTIRE PURPOSE is to count the archived rows —
    // `archived_at IS NOT NULL` is the inverse of the usual predicate, deliberately. It is
    // the measurement of what the default read withheld; filtering archived rows out of it
    // would make it report zero always, which is the silent under-count this whole feature
    // exists to remove. The table is interpolated from DISCLOSABLE_TABLES (a frozen
    // registry of literals), never from caller input.
    const res = allProjects
      ? await queryFn(
          `SELECT count(*)::int AS n FROM ${t.table} r WHERE r.${t.archivedColumn} IS NOT NULL`,
          []
        )
      : await queryFn(
          `SELECT count(*)::int AS n
             FROM ${t.table} r
             JOIN projects p ON p.id = r.${t.projectColumn}
            WHERE (p.id::text = $1 OR p.name = $1)
              AND r.${t.archivedColumn} IS NOT NULL`,
          [projectId]
        );
    excludedCount = Number(res.rows[0]?.n ?? 0);
  } catch (err) {
    logger.warn(
      `[archiveDisclosure] could not measure archived ${t.plural} for ` +
        `${allProjects ? 'all projects' : `project ${String(projectId)}`}` +
        ` — omitting the block rather than reporting a zero nobody measured: ` +
        (err instanceof Error ? err.message : String(err))
    );
    return null;
  }

  // THE TRI-STATE. `included` is decided by the FLAG, `none-archived` by the MEASUREMENT.
  // Both carry excludedCount 0 and they are deliberately not merged: one says the filter
  // found nothing to hide, the other says the filter did not apply.
  const state: ArchiveDisclosureState = includeArchived
    ? 'included'
    : excludedCount > 0
      ? 'excluded'
      : 'none-archived';

  return {
    includeArchived,
    state,
    excludedCount,
    entity,
    scopeNote: allProjects ? SCOPE_NOTE_ALL_PROJECTS : SCOPE_NOTE,
  };
}

/**
 * THE SINGLE RENDERER. The only composer of the disclosure sentence.
 *
 * Every state renders a line — including the zero ones. A read that printed nothing when
 * nothing was archived would be indistinguishable from a read taken before this existed,
 * which is the ambiguity the tri-state was introduced to remove.
 */
export function renderArchiveDisclosure(d: ArchiveDisclosure): string {
  const t = disclosableTable(d.entity);
  switch (d.state) {
    case 'excluded':
      return (
        `Archived ${t.plural} EXCLUDED: ${d.excludedCount} hidden by the default ` +
        `includeArchived:false — pass includeArchived:true to widen this read`
      );
    case 'none-archived':
      return `Archived ${t.plural} excluded: 0 (measured — this project has none archived)`;
    case 'included':
      return `Archived ${t.plural} INCLUDED (includeArchived:true) — nothing withheld`;
  }
}

/**
 * Merge the block into a structuredContent object under the shared key. Returns the same
 * object for call-site brevity; a null disclosure (could-not-measure, or no project scope)
 * stamps nothing.
 */
export function stampArchiveDisclosure<T extends Record<string, any>>(
  structured: T,
  disclosure: ArchiveDisclosure | null
): T {
  if (disclosure) (structured as any)[ARCHIVE_DISCLOSURE_KEY] = disclosure;
  return structured;
}

/**
 * THE ONE WIRING SEAM. Wrap a finished op response and attach the disclosure to BOTH
 * channels (structuredContent key + one rendered text line).
 *
 * It wraps the WHOLE handler rather than each `return` inside it because these handlers
 * have several exits — an id path, a tags path, a semantic path, and an empty-result path
 * — and the empty-result exit is the one that most needs the disclosure: "0 results" with
 * 429 rows archived is exactly the read that looks clean and is not. Stamping per-return
 * would have to be repeated at every exit and would be silently incomplete the first time
 * someone adds a fifth.
 *
 * ERROR RESPONSES ARE LEFT ALONE. A failed op did not narrow a population; hanging a
 * measurement off it would assert a read that never happened.
 */
export async function attachArchiveDisclosure(
  resp: any,
  queryFn: (sql: string, params: any[]) => Promise<{ rows: any[] }>,
  entity: DisclosableEntity | readonly DisclosableEntity[],
  projectId: DisclosureScope | null | undefined,
  includeArchived: boolean
): Promise<any> {
  if (!resp || resp.isError || resp.structuredContent?.ok === false) return resp;

  // MULTI-ENTITY OPS (project_insights) report one block PER entity, never one merged
  // number. Summing three tables into a single "excluded" count would produce a figure
  // that belongs to no population and reconciles with no other op — the same
  // number-without-units defect the disclosure exists to prevent.
  const entities = Array.isArray(entity) ? entity : [entity as DisclosableEntity];
  const measured: ArchiveDisclosure[] = [];
  for (const e of entities) {
    const d = await measureArchiveDisclosure(queryFn, e, projectId, includeArchived);
    if (d) measured.push(d);
  }
  if (measured.length === 0) return resp;

  // WHICH CHANNEL: the handlers use TWO conventions. Most set `structuredContent`; the
  // decision routes still set the legacy `data`, which routes/index.ts promotes to
  // `structuredContent` at the dual-channel seam — and that promotion PREFERS an existing
  // `structuredContent`. So creating one here on a `data`-only response would silently
  // discard the entire payload. Stamp the channel the handler actually used.
  const payload =
    resp.structuredContent && typeof resp.structuredContent === 'object'
      ? resp.structuredContent
      : resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)
        ? resp.data
        : (resp.structuredContent = {});

  stampArchiveDisclosure(payload, Array.isArray(entity) ? (measured as any) : measured[0]);

  const line = measured.map(renderArchiveDisclosure).join('\n');
  if (Array.isArray(resp.content)) {
    const lastText = [...resp.content].reverse().find((c: any) => c?.type === 'text');
    if (lastText) lastText.text = `${lastText.text}\n\n${line}`;
    else resp.content.push({ type: 'text', text: line });
  }

  return resp;
}
