/**
 * ARTIFACT-REFERENCE ROUTE — `context_artifact`.
 *
 * THE ONE THING THIS TOOL EXISTS FOR: a fresh orchestrator that knows an artifact was accepted
 * but does not possess it must be able to LOCATE and VERIFY it deterministically — no reading
 * a handoff for clues, no asking a human. It answers, from the record the artifact reference is
 * stored on:
 *
 *   source              — repository / producing thread / provider + locator
 *   expected identity   — hash, head, base
 *   retrieval steps     — the actual commands/instructions, with the real values substituted
 *   verification        — what MUST be observed, and (if the caller measured something) the
 *                         FAIL-CLOSED verdict on whether this is the accepted artifact
 *
 * MANDREL STILL NEVER STORES GIT. This route reads a jsonb reference and adjudicates strings.
 * It fetches nothing, hashes nothing, and touches no filesystem — the artifact bytes live
 * outside Mandrel, exactly as the evaluator confirmed they should.
 *
 * FAIL-CLOSED, LOUDLY. When the caller supplies an observed identity that CONTRADICTS the
 * expected one, this returns an ERROR response (isError) — not a success payload with a
 * warning buried in it. A wrong artifact must stop the caller. The structured channel still
 * carries the full verdict so the stop is debuggable.
 *
 * Follows the house route pattern (thread/link/recall): zod strict → route → derived
 * inputSchema → structuredContent, actionable errors, id8 accepted (resolved project-scoped),
 * parameterized SQL, project-scoped.
 */

import { projectHandler } from '../handlers/project.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { db } from '../config/database.js';
import { isFullUuid, normalizeShortId } from '../utils/idResolver.js';
import { formatRecordRef } from '../config/commandUrlConfig.js';
import {
  readMetadataArtifactRefs,
  resolveArtifactRef,
  validateArtifactRef,
  type ArtifactObserved,
  type ResolvedArtifact,
} from '../services/artifactRef.js';
import { ARTIFACT_REF_CONFIG } from '../config/artifactRefConfig.js';

type RecordType = 'context' | 'task' | 'decision';

/** The three record types that carry `metadata`, and the table each lives in. */
const RECORD_TABLES: ReadonlyArray<{ type: RecordType; table: string }> = [
  { type: 'context', table: 'contexts' },
  { type: 'task', table: 'tasks' },
  { type: 'decision', table: 'technical_decisions' },
];

interface FoundRecord {
  id: string;
  type: RecordType;
  metadata: Record<string, unknown>;
}

class ArtifactRoutes {
  /** Resolve the active project id (connection-scoped) — same idiom as the other routes. */
  private async resolveProjectId(
    argsProjectId: string | undefined,
    context?: RouteContext,
  ): Promise<string | undefined> {
    if (argsProjectId) return argsProjectId;
    const sessionId = context?.connectionId || 'default-session';
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution. Under a binding this is
    // the bound project; unbound it is rung 3, exactly as before.
    const projectId = await projectHandler.getCurrentProjectId(sessionId);
    return projectId || undefined;
  }

  /**
   * Find the record carrying the reference, by full UUID or 8+-hex short id, project-scoped.
   *
   * Searches every metadata-bearing table unless `recordType` narrows it. NEVER silently picks
   * between candidates: a prefix matching more than one record is reported with the candidates
   * (the same contract idResolver holds), because resolving provenance to the WRONG record is
   * exactly the class of quiet wrongness this whole task exists to remove.
   */
  private async findRecord(
    rawId: string,
    recordType: RecordType | undefined,
    projectId: string | undefined,
  ): Promise<FoundRecord[]> {
    const tables = recordType ? RECORD_TABLES.filter((t) => t.type === recordType) : RECORD_TABLES;
    const exact = isFullUuid(rawId);
    const needle = exact ? rawId : normalizeShortId(rawId);
    const found: FoundRecord[] = [];

    for (const { type, table } of tables) {
      // Parameterized; the table name is from the closed literal list above, never from input.
      const where = exact
        ? 'id = $1'
        : "replace(id::text, '-', '') LIKE $1 || '%'";
      const params: unknown[] = [needle];
      let sql = `SELECT id, metadata FROM ${table} WHERE ${where}`;
      if (projectId) {
        params.push(projectId);
        sql += ` AND project_id = $${params.length}`;
      }
      sql += ' LIMIT 5';
      const result = await db.query(sql, params);
      for (const row of result.rows) {
        const metadata =
          typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {});
        found.push({ id: row.id, type, metadata });
      }
    }
    return found;
  }

  /** Render one resolved artifact for the human channel. */
  private renderArtifact(a: ResolvedArtifact, index: number): string {
    const lines: string[] = [];
    lines.push(`\n📦 [${index}] ${a.artifactType}`);
    lines.push(`   source:     ${a.source.repository ?? '(no repository stated)'}`);
    if (a.source.producerThread) lines.push(`   produced by: ${a.source.producerThread}`);
    lines.push(`   identity:   head=${a.identity.head ?? '—'}  base=${a.identity.base ?? '—'}`);
    lines.push(`               ${a.identity.hashAlgorithm}=${a.identity.sha256 ?? '—'}`);
    lines.push(`   retrieval (${a.retrieval.provider}):`);
    for (const step of a.retrieval.instructions) lines.push(`     • ${step}`);
    lines.push(`   verify (FAIL-CLOSED — must observe: ${a.verification.mustObserve.join(', ')}):`);
    for (const step of a.verification.steps) lines.push(`     • ${step}`);
    if (a.verification.priorClaim) {
      const pc = a.verification.priorClaim;
      lines.push(
        `   prior claim (NOT trust-bearing): sha256=${pc.sha256 ?? '—'} head=${pc.head ?? '—'}` +
          `\n               ${pc.note}`,
      );
    }
    lines.push(`   status:     ${a.verification.verdict.status} — ${a.verification.verdict.reason}`);
    return lines.join('\n');
  }

  /**
   * context_artifact — resolve (and optionally adjudicate) a record's artifact references.
   *
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * THE POST-CONDITION (guard the guard).
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * Every individual fail-open hole found in review was the same shape: a branch that returns
   * BEFORE the adjudication runs, silently discarding a measurement the caller asked us to
   * check (an out-of-range index; then, one branch earlier, a record with zero references).
   * Patching each branch is fixing instances — and I found the second one only by re-walking
   * the code, which is exactly the reviewer's-luck I should not depend on.
   *
   * So the INVARIANT is enforced here, once, on the way out, where no future branch can miss
   * it: IF the caller supplied a measurement, the response is either an ERROR or it carries a
   * verdict. There is no third option. A new early-return added later inherits this for free;
   * the worst it can do is produce a blunt stop instead of a precise one.
   */
  async handleResolve(args: any, context?: RouteContext): Promise<McpResponse> {
    const measurementSupplied = !!(args?.observedSha256 || args?.observedHead);
    const response = await this.resolveInner(args, context);

    if (measurementSupplied && !response.isError && response.structuredContent?.verificationStatus === undefined) {
      return {
        content: [{
          type: 'text',
          text:
            '🛑 ADJUDICATION LOST — you supplied a measurement and this call produced no verdict for it.\n\n' +
            '⚠️  Treat the artifact as UNVERIFIED and do not proceed. This is a fail-closed stop: rather ' +
            'than return a success that quietly discards your measurement, the tool refuses.',
        }],
        isError: true,
        structuredContent: {
          ok: false,
          accepted: false,
          recordId: response.structuredContent?.recordId,
          reason: 'post-condition: a measurement was supplied but no verdict was produced',
        },
      };
    }
    return response;
  }

  private async resolveInner(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const projectId = await this.resolveProjectId(args?.projectId, context);
      const matches = await this.findRecord(args.id, args.recordType, projectId);

      if (matches.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              `❌ No ${args.recordType ?? 'context/task/decision'} record found for id "${args.id}"` +
              `${projectId ? ' in the current project' : ''}.\n\n` +
              '💡 Check the id, or pass projectId to widen/narrow the lookup.',
          }],
          isError: true,
          structuredContent: { ok: false, found: false, recordId: args.id },
        };
      }
      if (matches.length > 1) {
        // Never pick. Report the candidates and make the caller disambiguate.
        return {
          content: [{
            type: 'text',
            text:
              `❌ Id "${args.id}" is ambiguous — it matches ${matches.length} records:\n` +
              matches.map((m) => `   • ${m.type}: ${m.id}  ${formatRecordRef(m.id)}`).join('\n') +
              '\n\n💡 Pass the full UUID, or recordType=context|task|decision to disambiguate.',
          }],
          isError: true,
          structuredContent: {
            ok: false,
            ambiguous: true,
            recordId: args.id,
            candidates: matches.map((m) => ({ id: m.id, recordType: m.type })),
          },
        };
      }

      const record = matches[0];
      const key = ARTIFACT_REF_CONFIG.metadataKey;

      // N1: an unrecognised shape under the reserved key is UNRESOLVABLE, not "none". Reading
      // it as an empty list would hide real provenance behind a reassuring message.
      const read = readMetadataArtifactRefs(record.metadata);
      if (!read.ok) {
        return {
          content: [{
            type: 'text',
            text:
              `🛑 UNRESOLVABLE ARTIFACT METADATA on ${record.type} ${record.id}.\n\n${read.reason}\n\n` +
              '💡 Do not treat this as "no artifact" — the record is pointing at something and the ' +
              'pointer is malformed.',
          }],
          isError: true,
          structuredContent: {
            ok: false,
            recordId: record.id,
            recordType: record.type,
            storesArtifactBytes: false,
            errors: [read.reason],
          },
        };
      }
      const raws = read.refs;

      // The measurement the caller asked us to adjudicate, if any. Read BEFORE the empty-record
      // early return: an adjudication request must never be able to fall through a branch that
      // predates the guard (see the F1 note below — the same hole, one layer over).
      const observed: ArtifactObserved | undefined =
        args.observedSha256 || args.observedHead
          ? { sha256: args.observedSha256, head: args.observedHead }
          : undefined;

      if (raws.length === 0) {
        // ── F1 GUARD 0 ────────────────────────────────────────────────────────────────────
        // "There is nothing to adjudicate" is an ANSWER to a resolve, but it is a STOP for a
        // caller who measured something: they hold an artifact and this record cannot vouch
        // for it. Returning 200 here would discard their measurement exactly like the
        // out-of-range index did — the same fail-open class, one branch earlier.
        if (observed) {
          return {
            content: [{
              type: 'text',
              text:
                `🛑 ADJUDICATION IMPOSSIBLE — you supplied a measurement, but ${record.type} ` +
                `${record.id} carries NO artifact references to adjudicate it against.\n\n` +
                '⚠️  Treat the artifact as UNVERIFIED. This record accepts no artifact, so nothing here ' +
                'can vouch for what you fetched. Find the record that does.',
            }],
            isError: true,
            structuredContent: {
              ok: false,
              recordId: record.id,
              recordType: record.type,
              storesArtifactBytes: false,
              count: 0,
              accepted: false,
              reason: 'a measurement was supplied but the record carries no artifact references',
            },
          };
        }
        return {
          content: [{
            type: 'text',
            text:
              `📦 ${record.type} ${record.id} carries NO artifact references.\n\n` +
              `💡 An artifact reference is an array under metadata.${key}, e.g.\n` +
              `   metadata: {"${key}": [{"artifactType":"git-bundle","repository":"<org/repo>",` +
              `"head":"<sha>","sha256":"<64-hex>","retrieval":{"provider":"amp-thread-file","path":"<file>"}}]}`,
          }],
          structuredContent: {
            ok: true,
            found: true,
            recordId: record.id,
            recordType: record.type,
            storesArtifactBytes: false,
            count: 0,
            artifacts: [],
          },
        };
      }

      // A record written BEFORE this contract existed (or by a direct DB writer) can carry an
      // unresolvable reference. Report it as an explicit error entry rather than dropping it —
      // a silently-skipped reference is how provenance rots unnoticed.
      const index: number = args.index ?? 0;

      // ── F1 GUARD 1: an index that names no reference is a STOP ──────────────────────────
      // Left unchecked, `index: 5` on a 1-reference record aimed the caller's measurement at
      // nobody: the adjudication silently evaporated and the tool returned success saying
      // "not observed" — the caller's contradicting hash swallowed whole. A caller mistake is
      // never a silent no-op on a surface whose entire job is to stop a wrong artifact.
      if (args.index !== undefined && index >= raws.length) {
        return {
          content: [{
            type: 'text',
            text:
              `🛑 index ${index} names no artifact reference — ${record.type} ${record.id} carries ` +
              `${raws.length} (valid indexes 0..${raws.length - 1}).\n\n` +
              (observed
                ? '⚠️  You supplied a MEASUREMENT for this index. It was NOT adjudicated against anything — ' +
                  'treat this as UNVERIFIED and re-run against a valid index. Do not proceed.'
                : '💡 Re-run with a valid index, or omit it to resolve every reference.'),
          }],
          isError: true,
          structuredContent: {
            ok: false,
            recordId: record.id,
            recordType: record.type,
            storesArtifactBytes: false,
            count: raws.length,
            accepted: false,
            reason: `index ${index} out of range (record carries ${raws.length} reference(s))`,
          },
        };
      }

      const resolved: Array<ResolvedArtifact | { error: string; position: number }> = [];
      const errors: string[] = [];
      raws.forEach((raw, i) => {
        const check = validateArtifactRef(raw, ARTIFACT_REF_CONFIG, `metadata.${key}[${i}]`);
        if (!check.ok) {
          errors.push(...check.errors);
          resolved.push({ error: check.errors.join('; '), position: i });
          return;
        }
        // The observed identity applies ONLY to the reference being adjudicated.
        resolved.push(resolveArtifactRef(raw, i === index ? observed : undefined));
      });

      const target = resolved[index];
      const targetResolved =
        target && !('error' in target) ? (target as ResolvedArtifact) : undefined;
      const verdict = targetResolved?.verification.verdict;

      // ── F1 GUARD 2: a requested adjudication that produced NO verdict is a STOP ─────────
      // Independent of guard 1 on purpose (defence in depth): guard 1 covers the out-of-range
      // index, this covers EVERY other way a verdict can fail to appear — chiefly an index
      // pointing at a reference too malformed to resolve. The invariant is simple and holds
      // regardless of cause: if the caller measured something, they get a verdict or an error.
      // Never a 200 that quietly discards their measurement.
      if (observed && !verdict) {
        const why = target && 'error' in target ? target.error : 'the reference could not be resolved';
        return {
          content: [{
            type: 'text',
            text:
              `🛑 ADJUDICATION FAILED — you supplied a measurement for [${index}] and it could NOT be ` +
              `adjudicated.\n\n${why}\n\n` +
              '⚠️  Treat the artifact as UNVERIFIED. Do not proceed on the strength of an unadjudicated measurement.',
          }],
          isError: true,
          structuredContent: {
            ok: false,
            recordId: record.id,
            recordType: record.type,
            storesArtifactBytes: false,
            count: raws.length,
            accepted: false,
            reason: `adjudication requested for index ${index} but no verdict could be produced: ${why}`,
            errors,
          },
        };
      }

      const header =
        `📦 ${record.type} ${record.id} — ${raws.length} artifact reference${raws.length === 1 ? '' : 's'}` +
        `  ${formatRecordRef(record.id)}\n` +
        'ℹ️  Mandrel stores NO artifact bytes — this is the location + identity + verification contract.';

      const body = resolved
        .map((r, i) => ('error' in r ? `\n📦 [${i}] ⚠️ UNRESOLVABLE REFERENCE: ${r.error}` : this.renderArtifact(r, i)))
        .join('\n');

      // ── FAIL-CLOSED STOP ────────────────────────────────────────────────────────────
      // The caller measured an identity and it contradicts the accepted one. This is an
      // ERROR response, not a success with a caveat: the artifact in their hands is not the
      // artifact this record accepted, and continuing would build on the wrong base.
      if (verdict?.status === 'blocked') {
        return {
          content: [{
            type: 'text',
            text:
              `🛑 ARTIFACT VERIFICATION FAILED — acceptance BLOCKED.\n\n${verdict.reason}\n\n` +
              `${header}${body}\n\n` +
              '💡 Do NOT proceed with this artifact. Re-fetch from the stated source and re-verify; ' +
              'if it still mismatches, the reference or the artifact is wrong and that is the finding.',
          }],
          isError: true,
          structuredContent: {
            ok: false,
            recordId: record.id,
            recordType: record.type,
            storesArtifactBytes: false,
            count: raws.length,
            accepted: false,
            verificationStatus: verdict.status,
            reason: verdict.reason,
            artifacts: resolved as unknown as Array<Record<string, any>>,
            errors,
          },
        };
      }

      const verdictLine = verdict
        ? `\n\n${verdict.accepted ? '✅' : '⚠️'} [${index}] ${verdict.status.toUpperCase()} — ${verdict.reason}`
        : '';

      return {
        content: [{ type: 'text', text: `${header}${body}${verdictLine}` }],
        structuredContent: {
          ok: true,
          found: true,
          recordId: record.id,
          recordType: record.type,
          storesArtifactBytes: false,
          count: raws.length,
          // ALWAYS present, never conditional. `accepted:false` with status 'unverified' is the
          // honest resting state of an artifact nobody has measured yet — hiding the field would
          // let a caller read its ABSENCE as "fine". A consumer can key on `accepted` alone and
          // be safe: it is true only after a full, matching observation.
          ...(verdict
            ? { accepted: verdict.accepted, verificationStatus: verdict.status, reason: verdict.reason }
            : {}),
          artifacts: resolved as unknown as Array<Record<string, any>>,
          ...(errors.length > 0 ? { errors } : {}),
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'context_artifact');
    }
  }
}

export const artifactRoutes = new ArtifactRoutes();
