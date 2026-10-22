/**
 * punchMerge — the SAME shallow-merge-with-null-deletes semantics `metadataMergeSql` gives
 * the top-level `metadata` column (utils/metadataMerge.ts), one level deeper: shallow-merges
 * an incoming `punch` object into whatever already lives at `metadata.punch`, atomically in
 * SQL. A caller setting only `doneWhen` must not erase an existing `proofKind` — the same
 * "explicit null deletes a key, an omitted key is silence" contract metadataMergeSql
 * documents, applied at metadata's `punch` sub-key instead of at its top level (migration
 * 101).
 */

import { PUNCH_METADATA_KEY } from '../config/taskStageConfig.js';
import { PunchDependsOnDirectError } from '../services/taskPunchCompleteness.js';

/**
 * Build the SQL expression that shallow-merges `incoming` into `${baseExpr}->'punch'` and
 * jsonb_sets it back onto `${baseExpr}` at the `punch` key. `baseExpr` is whatever the
 * metadata expression already is at this point in the SET-clause composition (either the
 * bare column name or a previously-nested expression — same nesting contract
 * metadataMergeSql/appendJsonbLogSql use in handlers/tasks.ts).
 *
 * @param baseExpr the metadata SQL expression to jsonb_set('{punch}', ...) onto.
 * @param paramIdx  the 1-based positional index of the FIRST param this emits.
 * @param incoming  the incoming punch object (may contain nulls to delete a punch sub-key).
 */
export function punchMergeSql(
  baseExpr: string,
  paramIdx: number,
  incoming: Record<string, any>,
): { expr: string; params: any[] } {
  const nullKeys = Object.entries(incoming)
    .filter(([, v]) => v === null)
    .map(([k]) => k);

  const params: any[] = [JSON.stringify(incoming)];

  let punchExpr = `COALESCE(${baseExpr}->'${PUNCH_METADATA_KEY}', '{}'::jsonb) || $${paramIdx}::jsonb`;
  if (nullKeys.length > 0) {
    punchExpr = `(${punchExpr}) - $${paramIdx + 1}::text[]`;
    params.push(nullKeys);
  }

  const expr = `jsonb_set(COALESCE(${baseExpr}, '{}'::jsonb), '{${PUNCH_METADATA_KEY}}', ${punchExpr})`;
  return { expr, params };
}

/**
 * THE CLOBBER FIX. `metadata.punch` arriving
 * through the top-level `metadata` argument used to reach `metadataMergeSql` untouched — and
 * that helper's shallow merge is a jsonb `||` at the TOP LEVEL, which REPLACES the whole
 * `punch` value wholesale (it does not know `punch` is itself a bag with its own sub-keys).
 * A note-only `task_update` carrying `metadata: { punch: { doneWhen: [...] } }` therefore
 * deleted the picker's `intake`/`walkthrough`/`merge` sub-keys on the same call, which is
 * exactly what parked two live punches at the merge actor on 2026-09-21.
 *
 * THE FIX: pull `punch` OUT of the incoming `metadata` object before it ever reaches
 * `metadataMergeSql`, and fold it into the SAME `punch` argument that already routes through
 * `punchMergeSql`'s shallow-merge-at-the-sub-key semantics. The explicit `punch` argument
 * wins over `metadata.punch` on any overlapping key (applied second, same "last write in the
 * merge order wins" convention this file's top-of-file note documents) — `metadata.punch` is
 * treated as an ALTERNATE CHANNEL for the same data, never a second source of truth.
 *
 * Returns `metadata` unchanged (same reference) when it carries no `punch` key, so a caller
 * that never touches punch causes zero extra allocation.
 */
export function splitMetadataPunch(
  metadata: Record<string, any> | undefined,
  punch: Record<string, any> | undefined,
): { metadata: Record<string, any> | undefined; punch: Record<string, any> | undefined } {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, PUNCH_METADATA_KEY)) {
    return { metadata, punch };
  }
  const { [PUNCH_METADATA_KEY]: metadataPunch, ...rest } = metadata;
  const combined = { ...(metadataPunch ?? {}), ...(punch ?? {}) };
  return { metadata: rest, punch: combined };
}

/**
 * THE `dependsOn` MIRROR. `punch.dependsOn` is
 * not an independent field — it is the SAME dependency list `dependencies` already carries,
 * republished under the name the picker actually reads. Letting a caller set it directly
 * would let the two drift again, which is precisely what orphaned the TreeWalker P2/P2a/P3
 * punches under an earlier decision (the form wrote `task.dependencies`; the picker read
 * `punch.dependsOn`, and nothing kept them equal).
 *
 * WHEN `dependencies` IS part of THIS call: `dependsOn` is overwritten with the resolved
 * dependencies, regardless of what a caller may also have placed at `punch.dependsOn` — one
 * source of truth, not a merge of two. WHEN IT IS NOT part of this call: a caller-supplied
 * `punch.dependsOn` (from either the `punch` argument or the `metadata.punch` alternate
 * channel `splitMetadataPunch` folds in above) is REFUSED, nothing written, naming the field.
 */
export function reconcilePunchDependsOn(
  tool: string,
  punch: Record<string, any> | undefined,
  dependenciesProvided: boolean,
  resolvedDependencies: string[] | undefined,
): Record<string, any> | undefined {
  if (dependenciesProvided) {
    return { ...(punch ?? {}), dependsOn: resolvedDependencies ?? [] };
  }
  if (punch !== undefined && Object.prototype.hasOwnProperty.call(punch, 'dependsOn')) {
    throw new PunchDependsOnDirectError(tool);
  }
  return punch;
}
