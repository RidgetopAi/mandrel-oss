/**
 * BRANCH POSITION ROUTES — PHASE 1 positional membership.
 *
 * Handles: branch_open (stand on a branch — the spine may be a context, decision, OR task),
 *          branch_current (where am I standing), branch_close (step off),
 *          branch_history (what was written on this branch — SK2).
 *
 * These REPLACE the retired active-thread anchor tools (thread_set / thread_current /
 * thread_clear, kept as WARN-and-delegate deprecation aliases in thread.routes.ts). The
 * position lives in `branch_positions` (migration 080), keyed per (project, session) through
 * projectHandler.resolveSessionScopedKeying — the one strict-keying choke point. No TTL, no
 * similarity gate: while a position is open, EVERY write (context_store, decision_record,
 * task_create) stamps a declared `informs` edge (created_by 'auto:positional') to the spine
 * via services/positionalMint.ts.
 *
 * ee160aad fold-in: branch_open always resolves to a REAL spine record — an id that
 * resolves to nothing in any of the three tables is an actionable error, so "current
 * branch" can never be unnamed or dangling.
 *
 * SK2 added branch_history, and it reads from a DIFFERENT place than the
 * other three on purpose. open/current/close all touch `branch_positions`, the LIVE POINTER,
 * which branch_close hard-DELETEs. History therefore cannot come from there — a finished
 * branch has no row. It comes from the membership edges in `links`, which nothing deletes,
 * via services/branchMembership.ts. That is why a closed branch can still be read back, and
 * why branch_history is the only one of the four that needs no session position at all.
 */

import { projectHandler, AnchorSessionKeyError } from '../handlers/project.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import type { RouteContext } from './index.js';
import { db } from '../config/database.js';
import { formatRecordRef, recordUrl } from '../config/commandUrlConfig.js';
import { resolveSpineRecord, spineResolutionError, spineLiveness } from '../services/spineResolver.js';
import { danglingSpineRefused } from '../config/danglingSpineConfig.js';
import {
  openPositionAny,
  readPositionAny,
  closePositionAny,
  type BranchPosition,
  type SpineType,
} from '../services/branchPosition.js';
import {
  readBranchMembers,
  isBranchOpen,
  resolveMemberTitles,
  assignMembership,
  removeMembership,
  MEMBERSHIP_WRITE_REFUSAL,
  type MemberType,
} from '../services/branchMembership.js';
import { BRANCH_HISTORY_CONFIG } from '../config/branchHistoryConfig.js';
import { APPROXIMATE_SOURCES, MEMBERSHIP_SOURCE } from '../config/membershipSourceConfig.js';

class BranchRoutes {
  /** Resolve the active project id (connection-scoped), same idiom as the other routes. */
  private async resolveProjectId(
    argsProjectId: string | undefined,
    context?: RouteContext
  ): Promise<string | undefined> {
    if (argsProjectId) return argsProjectId;
    const sessionId = context?.connectionId || 'default-session';
    await projectHandler.initializeSession(sessionId);
    // PROJECT-SCOPE: effective — a route's own project resolution (bound project under a
    // binding; rung 3 unbound), exactly like thread/context/task routes.
    const projectId = await projectHandler.getCurrentProjectId(sessionId);
    return projectId || undefined;
  }

  private getSessionId(context?: RouteContext): string {
    return context?.connectionId || 'default-session';
  }

  /**
   * Resolve the session key or return the strict-keying refusal as a thrown typed error
   * (branch state under a shared fallback key would be the cross-session leak strict mode
   * exists to refuse — same contract as the retired thread tools). WRITE paths only
   * (branch_open, branch_close): a write under a shared fallback key is the cross-session
   * leak strict mode exists to refuse, so it stays a loud typed throw.
   */
  private requireSessionKeys(toolName: string, sessionId: string): string[] {
    const keying = projectHandler.resolvePositionKeys(sessionId);
    if (keying.refusal !== undefined) {
      throw new AnchorSessionKeyError(toolName, sessionId);
    }
    return keying.keys;
  }

  /**
   * Resolve the session key for a READ (branch_current), refusal reported rather than
   * thrown. branch_current answers "where am I standing" — under an
   * unresolvable key the honest answer is "cannot determine", not a thrown error, because
   * unlike branch_open/branch_close this path writes NOTHING under the fallback key; there
   * is no shared-key leak for a read to refuse. Same judgment requireSessionKeys makes,
   * surfaced instead of thrown — the read-side counterpart to
   * projectHandler.anchorStrictKeySkipReason (the write-side auto-thread skip surfacing).
   */
  private resolveSessionKeysForRead(sessionId: string): { keys: string[]; refusal?: undefined } | { keys?: undefined; refusal: string } {
    return projectHandler.resolvePositionKeys(sessionId);
  }

  /**
   * Resolve a spine id (full UUID or id8) against ALL THREE record tables, project-scoped.
   * NEVER first-match (the E3 caveat). The rules and the error text now
   * live in services/spineResolver.ts — SHARED with project_briefing's `spine` argument, so
   * there is exactly one definition of what a spine id resolves to. This method is the thin
   * adapter that keeps branch_open / branch_history's existing return shape.
   */
  private async resolveSpine(
    rawId: string,
    projectId: string | undefined,
    toolName: string
  ): Promise<{ spineId: string; spineType: SpineType } | { error: McpResponse }> {
    const res = await resolveSpineRecord(rawId, projectId);
    if (res.ok) return { spineId: res.spineId, spineType: res.spineType };
    return { error: spineResolutionError(res, toolName) };
  }

  /** Best-effort human title for a spine record (null if unreadable — never throws). */
  private async spineTitle(spineId: string, spineType: SpineType): Promise<string | null> {
    try {
      if (spineType === 'task') {
        const r = await db.query('SELECT title FROM tasks WHERE id = $1', [spineId]);
        return r.rows[0]?.title ?? null;
      }
      if (spineType === 'decision') {
        const r = await db.query('SELECT title FROM technical_decisions WHERE id = $1', [spineId]);
        return r.rows[0]?.title ?? null;
      }
      const r = await db.query('SELECT content FROM contexts WHERE id = $1', [spineId]);
      const content = r.rows[0]?.content;
      return content ? `${String(content).replace(/\s+/g, ' ').slice(0, 60)}…` : null;
    } catch {
      return null;
    }
  }

  /** Render one position as the shared text + structured pair. */
  private async renderPosition(position: BranchPosition): Promise<{
    line: string;
    structured: Record<string, any>;
  }> {
    const title = await this.spineTitle(position.spineId, position.spineType);
    return {
      line:
        `   • spine: ${position.spineType} ${position.spineId}` +
        `${title ? ` ("${title}")` : ''}  ${formatRecordRef(position.spineId)}`,
      structured: {
        spineId: position.spineId,
        spineType: position.spineType,
        spineTitle: title,
        spineUrl: recordUrl(position.spineId),
        openedAt: position.openedAt instanceof Date
          ? position.openedAt.toISOString()
          : String(position.openedAt),
        // AUTO-OPEN: the state that explains WHY writes are attaching where
        // they are. `origin` is the one a caller must read before trusting spineId.
        origin: position.origin,
        tipId: position.tipId,
        tipType: position.tipType,
        memberWrites: position.memberWrites,
      },
    };
  }

  /**
   * branch_open — stand on a branch. `id` (full UUID or id8) resolves to a real context,
   * decision, or task, project-scoped, across all three tables. Re-opening onto a different
   * spine MOVES the position (the interrupt/switch semantic); the response reports the
   * previous position when one existed, so a move is visible, never silent.
   */
  async handleOpen(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      if (args.id === undefined || args.id === null || args.id === '') {
        return {
          content: [{
            type: 'text',
            text:
              '❌ branch_open requires `id` — the record to stand on (context, decision, or ' +
              'task; full UUID or 8+-hex short id).\n\n' +
              '💡 Every write made while the branch is open stamps a declared edge to this spine.',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const sessionId = this.getSessionId(context);
      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: '❌ branch_open: no active project to key the position against.\n\n' +
                  '💡 project_switch first (or pass projectId).',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }
      const sessionKeys = this.requireSessionKeys('branch_open', sessionId);

      const spine = await this.resolveSpine(String(args.id), projectId, 'branch_open');
      if ('error' in spine) return spine.error;

      const previous = await readPositionAny(projectId, sessionKeys);
      const position = await openPositionAny({
        projectId,
        keys: sessionKeys,
        spineId: spine.spineId,
        spineType: spine.spineType,
      });
      const rendered = await this.renderPosition(position);

      const moved = !!previous && previous.spineId !== position.spineId;
      const lines = [
        moved
          ? '🧭 Branch MOVED (previous position replaced). Writes now land on:'
          : '🧭 Branch open. Every write now stamps a declared edge onto:',
        rendered.line,
      ];
      if (moved && previous) {
        lines.push(
          `   (was: ${previous.spineType} ${previous.spineId.substring(0, 8)} — pop back with ` +
            `branch_open ${previous.spineId.substring(0, 8)})`
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          action: 'opened',
          position: rendered.structured,
          previousPosition: previous
            ? { spineId: previous.spineId, spineType: previous.spineType }
            : null,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'branch_open');
    }
  }

  /** branch_current — where is this session standing (or a clear "no branch open"). */
  async handleCurrent(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const sessionId = this.getSessionId(context);
      // A READ under an unresolvable key answers "position unavailable" rather than
      // throwing (an earlier task — this refusal made every cold boot blind until it wrote).
      // branch_open/branch_close still throw AnchorSessionKeyError via requireSessionKeys:
      // THEY write under the key, so the shared-fallback leak strict mode refuses is real
      // for them and not for a read that mints nothing.
      const keying = this.resolveSessionKeysForRead(sessionId);
      if (keying.refusal !== undefined) {
        return {
          content: [{
            type: 'text',
            text:
              '🧭 Position unavailable — no session identity is resolved for this connection ' +
              'yet, and strict anchor keying is enabled, so there is no per-session key to read ' +
              "a position from. This is not the same as \"no branch open\": it means the answer " +
              "can't be determined yet.\n\n" +
              '💡 Identify this connection (send a stable `X-Connection-ID` header) and run a ' +
              'session-creating operation (e.g. context_store), then check again.',
          }],
          structuredContent: {
            ok: true,
            action: 'current',
            position: null,
            positionUnavailable: true,
            reason: keying.refusal,
          },
        };
      }
      const sessionKeys = keying.keys;
      const projectId = await this.resolveProjectId(args.projectId, context);
      const position = projectId ? await readPositionAny(projectId, sessionKeys) : null;

      if (!position) {
        return {
          content: [{
            type: 'text',
            text:
              '🧭 No branch open for this session.\n\n' +
              '💡 branch_open <id> to stand on one (context, decision, or task) — or just ' +
              'write: the response offers your record\'s own id as a spine.',
          }],
          structuredContent: { ok: true, action: 'current', position: null },
        };
      }

      // THE SPINE MUST STILL EXIST (signal 2). `branch_positions.spine_id`
      // is a soft reference — migration 080 — so the record can be deleted out from under
      // an open position and nothing removes the row. Measured on prod: this endpoint
      // reported `spineType: "task"` for f50b8f30, an id its own by-id lookup resolves to
      // nothing. Reproduced from a clean DB in tests/danglingSpine.contract.test.ts, where
      // the pre-fix render was an ORDINARY OPEN BRANCH — origin 'declared', spineType
      // 'task' — separable from a healthy one only by a null title, and `spineTitle()`
      // returns null for a titleless record too. Rule: config/danglingSpineConfig.ts.
      //
      // CHECKED FOR THE TRUNK ROW AS WELL, and that is the half the bug report was actually
      // filed on: at trunk `spineId` moves to `revertedFrom`, so a check that ran only on
      // the position path would leave the exact observed shape untouched while looking
      // fixed. Provenance is still an assertion about a record — if it names a type, the
      // type has to be true.
      const liveness = danglingSpineRefused()
        ? await spineLiveness(position.spineId, position.spineType)
        : { exists: true, archived: false };

      if (!liveness.exists) {
        const short = position.spineId.substring(0, 8);
        return {
          content: [{
            type: 'text',
            text: [
              `⚠️  This session's branch position points at a ${position.spineType} that NO ` +
                'LONGER EXISTS — nothing is being threaded to it.',
              `   (spine ${short}, opened ${position.openedAt instanceof Date ? position.openedAt.toISOString() : String(position.openedAt)}; ` +
                'the record was deleted after the position was taken)',
              '💡 branch_close to step off, or branch_open <id> to stand somewhere real.',
            ].join('\n'),
          }],
          structuredContent: {
            ok: true,
            action: 'current',
            // NOT a position, for the same reason trunk is not one: a caller branches on
            // this field to decide whether its writes are threading, and they are not.
            position: null,
            atTrunk: false,
            // DELIBERATELY A THIRD, DISTINCT SHAPE. ABSENT returns `position:null` alone and
            // TRUNK returns `revertedFrom`; if DANGLING collapsed onto either, "I opened a
            // branch and my writes stopped threading" would be indistinguishable from "I
            // never opened one" — different problems, different fixes. It carries no
            // `spineType` key, so the id cannot be re-asserted as a type nothing resolves.
            danglingSpine: { spineId: position.spineId, missingType: position.spineType },
          },
        };
      }

      // ARCHIVED IS A THIRD STATE, AND IT IS THE ONE THE BUG WAS FILED ON.
      // an earlier Task reported that this endpoint claimed `spineType:'task'` for f50b8f30
      // while `task details` answered found:false, and read that as a dangling pointer.
      // Measured on prod 2026-09-05, the row EXISTS (status 'todo', archived_at
      // 2026-09-02) — `task details` could not see it because includeArchived:false is the
      // default on the read ops. The caller was not given a false id; it was given a true
      // one it had no way to look up, which is why "a spineType its own by-id lookup cannot
      // resolve" was a fair complaint about a spine that is really there.
      //
      // COMPUTED HERE, ABOVE THE TRUNK ARM, AND THAT PLACEMENT IS THE FIX (reject round 1).
      // It was first written below the trunk arm, which returns early — so an archived spine
      // AT TRUNK emitted a `spineType` and no archived signal whatsoever, leaving the coordinator's
      // originally-reported observation byte-for-byte reproducible after two commits that
      // claimed to have addressed it. That is the same error those commits warn against, one
      // arm over: a51a62f2's own comment calls trunk "the half the bug report was actually
      // filed on", and 933b495d's whole argument is that a fix which changes nothing on the
      // case that produced the report is inadequate. ONE source, consumed by BOTH arms, is
      // why that can no longer drift apart — a second copy is a second chance to fix one and
      // not the other.
      const archived = liveness.archived;
      const archivedNote = archived
        ? [`   ⚠️  this ${position.spineType} is ARCHIVED — it is still a real record, but the ` +
           'default includeArchived:false hides it from task/decision/context lookups, so a ' +
           'by-id read of it will report NOT FOUND.']
        : [];

      const rendered = await this.renderPosition(position);

      // AT TRUNK (R2/R5): the row exists but the session is NOT standing on
      // its spine — that id is only the record it reverted FROM. Saying "current branch:
      // <spine>" here would be the guard-name-lies-about-its-predicate failure in prose:
      // the caller would read a position that mints nothing as one that mints.
      if (position.origin === 'trunk') {
        return {
          content: [{
            type: 'text',
            text: [
              '🧭 This session is at TRUNK — no branch is open, and writes stamp NO membership edge.',
              `   (reverted from ${position.spineType} ${position.spineId.substring(0, 8)} after a same-type ` +
                'create in a row was read as coordination, not branch work)',
              ...archivedNote,
              '💡 branch_open <id> to stand on a branch deliberately — that is what exits trunk.',
            ].join('\n'),
          }],
          structuredContent: {
            ok: true,
            action: 'current',
            // NOT a position: nothing is minted from here, so the field a caller branches on
            // must not be populated with something that looks like one.
            position: null,
            atTrunk: true,
            // PROVENANCE IS STILL AN ASSERTION ABOUT A RECORD. This arm mints nothing, but it
            // names an id AND a type, and a caller that looks that pair up must be able to
            // reconcile the answer it gets. `spineArchived` is what lets it tell "the id is
            // wrong" from "the id is right and my lookup is filtered".
            revertedFrom: {
              spineId: position.spineId,
              spineType: position.spineType,
              spineArchived: archived,
            },
          },
        };
      }

      return {
        content: [{
          type: 'text',
          text: ['🧭 Current branch for this session:', rendered.line, ...archivedNote,
                 position.origin === 'auto'
                   ? '   (opened automatically when you created this record — writes stamp a declared informs edge onto it; branch_close to step off)'
                   : '   (writes stamp a declared informs edge onto the spine — branch_close to step off)'].join('\n'),
        }],
        structuredContent: {
          ok: true,
          action: 'current',
          position: { ...rendered.structured, spineArchived: archived },
          atTrunk: false,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'branch_current');
    }
  }

  /** branch_close — step off the branch. Idempotent; names what was closed. */
  async handleClose(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      const sessionId = this.getSessionId(context);
      const sessionKeys = this.requireSessionKeys('branch_close', sessionId);
      const projectId = await this.resolveProjectId(args.projectId, context);
      const closed = projectId ? await closePositionAny(projectId, sessionKeys) : null;

      return {
        content: [{
          type: 'text',
          text: closed
            ? `🧭 Branch closed (was ${closed.spineType} ${closed.spineId.substring(0, 8)}). ` +
              'New writes no longer stamp positional edges.'
            : 'ℹ️  No branch was open (nothing to close).',
        }],
        structuredContent: {
          ok: true,
          action: closed ? 'closed' : 'absent',
          position: null,
          closedPosition: closed
            ? { spineId: closed.spineId, spineType: closed.spineType }
            : null,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'branch_close');
    }
  }

  /**
   * branch_history — every record written on a branch, in the order they were written.
   *
   * MEMBERSHIP IS A STORED FACT, READ FLAT. Each write records the ROOT SPINE of the
   * position it was made on in its own row (branch_memberships.spine_id, migration 086), so
   * this is one equality with no traversal: a capture made after the branch advanced its tip
   * is found because it carries the root, and a NESTED branch's writes are excluded because
   * they carry theirs. SK2 round 1 reconstructed this by walking to_id and could do neither —
   * the two cases are the same row shape, and it absorbed the second into the first. Round 3
   * moved it OFF the edge entirely: the positional edge can be swallowed by an earlier tag
   * mint on the same (from,to,edge_type) triple, and half of every real branch was.
   *
   * WHAT MAKES THIS DIFFERENT FROM THE OTHER THREE: it takes NO session position and needs
   * none. open/current/close read and write `branch_positions`, which branch_close hard-
   * DELETEs; history reads the membership edges, which survive. So any session can ask about
   * any branch in its project, open or closed, forever. That durability is the deliverable —
   * before SK2 a branch's lifecycle was unrecoverable the moment somebody stepped off it.
   *
   * PROJECT SCOPE, two layers — stated with what each one can actually stop, because SK2
   * round 1 asserted a defence here that no test could falsify (the reviewer F2):
   *   1. THE ONE THAT FIRES IN PRODUCT: the spine id is resolved through the same
   *      project-scoped, never-first-match resolver branch_open uses, so an id from another
   *      project resolves to nothing and the call ends before any membership read.
   *   2. `project_id` on the membership read itself. Because record ids are UUIDs, no
   *      PRODUCT path can put a foreign member behind a resolvable spine — so this layer
   *      only bites on a row written outside the mint (raw SQL, a migration, a future
   *      service). That is a real state the table permits, and it is what
   *      sk2BranchHistory's 'a foreign-project membership row is not returned' case writes
   *      by hand. Delete the filter and that test goes RED; if it ever stops being able to,
   *      delete this paragraph rather than leaving an unfalsifiable claim.
   */
  async handleHistory(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      if (args.id === undefined || args.id === null || args.id === '') {
        return {
          content: [{
            type: 'text',
            text:
              '❌ branch_history requires `id` — the branch SPINE to read (context, decision, ' +
              'or task; full UUID or 8+-hex short id).\n\n' +
              '💡 The branch does NOT have to be open: history is read from the membership ' +
              'edges, which outlive branch_close.',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: '❌ branch_history: no active project to scope the branch against.\n\n' +
                  '💡 project_switch first (or pass projectId).',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const spine = await this.resolveSpine(String(args.id), projectId, 'branch_history');
      if ('error' in spine) return spine.error;

      // Clamp rather than reject (branchHistoryConfig.ts states why), and report the clamp.
      const requested = typeof args.limit === 'number' ? args.limit : undefined;
      const limit = Math.max(
        1,
        Math.min(requested ?? BRANCH_HISTORY_CONFIG.defaultLimit, BRANCH_HISTORY_CONFIG.maxLimit)
      );
      const limitClamped = requested !== undefined && requested > BRANCH_HISTORY_CONFIG.maxLimit;

      const [membership, open, spineTitle] = await Promise.all([
        readBranchMembers({ projectId, spineId: spine.spineId }),
        isBranchOpen(projectId, spine.spineId),
        this.spineTitle(spine.spineId, spine.spineType),
      ]);

      const total = membership.members.length;
      const page = membership.members.slice(0, limit);
      const omitted = total - page.length;
      const titles = await resolveMemberTitles(
        page.map((m) => ({ id: m.id, type: m.type as MemberType }))
      );

      const members = page.map((m) => ({
        id: m.id,
        type: m.type,
        title: titles.get(m.id) ?? null,
        url: recordUrl(m.id),
        edgeType: m.edgeType,
        mintVia: m.mintVia,
        provenanceClass: m.provenanceClass,
        createdAt: m.createdAt,
        // WHERE the edge points. Equal to the spine for a directly-attached member; an
        // earlier member's id for a write made after the position advanced its tip. It is
        // NOT how this record was selected — membership is the recorded position spine —
        // and it is surfaced so a reader can see the two are different things.
        attachedToId: m.attachedToId,
        // 'recorded' | 'legacy-approx' (MEMBERSHIP_SOURCE). Per-member rather than
        // per-response so a branch that straddles the migration says which rows are which.
        spineSource: m.spineSource,
      }));

      // BOTH CHANNELS, ALWAYS. Shipping a populated structuredContent beside an empty text
      // body (or the reverse) is a defect this repo has shipped before — SK8, two releases
      // ago. The two renderings below are built from the same `members` array so neither can
      // be populated without the other.
      const lines: string[] = [
        open
          ? `🌿 Branch history — ${spine.spineType} ${spine.spineId.substring(0, 8)} (OPEN: a session is standing on it now)`
          : `🌿 Branch history — ${spine.spineType} ${spine.spineId.substring(0, 8)} (no session is standing on it)`,
        `   spine: ${spineTitle ? `"${spineTitle}"` : '(untitled)'}  ${formatRecordRef(spine.spineId)}`,
        '',
      ];
      if (total === 0) {
        lines.push(
          '   (no members — no write here recorded a position; a trunk record or an opted-out write is not a member)',
          '   💡 Membership is minted only by a POSITIONED write. A record that merely tags or',
          '      links this spine is not a member of it.'
        );
      } else {
        lines.push(`   ${page.length} of ${total} member${total === 1 ? '' : 's'}, in write order:`);
        page.forEach((m, i) => {
          const t = titles.get(m.id);
          // The marker says what the DATA says and nothing more: this member's edge attaches
          // to another member rather than to the spine (the position's tip had advanced).
          // The round-1 renderer said "[via tip +N]" for records reached by a walk, which
          // asserted a causal history the rows do not carry — and was wrong for every
          // nested-branch record the walk had absorbed (the reviewer).
          const attach =
            m.attachedToId !== spine.spineId ? `  [attached to ${m.attachedToId.substring(0, 8)}]` : '';
          const approx =
            APPROXIMATE_SOURCES.has(m.spineSource) ? '  [branch inferred: pre-086 write]' : '';
          // A DECLARED assignment is a fact, so it gets no approximation caveat — but it is a
          // DIFFERENT fact from an observed position, and the structured channel already says
          // so in `spineSource`. A field the machine channel carries and the text channel
          // drops is how a human ends up reading a corrected branch as an original one.
          const declared =
            m.spineSource === MEMBERSHIP_SOURCE.assigned ? '  [branch assigned]' : '';
          lines.push(
            `   ${String(i + 1).padStart(3)}. ${m.type.padEnd(8)} ${m.id.substring(0, 8)}  ` +
              `${m.createdAt}${attach}${approx}${declared}` +
              `${t ? `\n        "${t}"` : ''}`
          );
        });
      }
      // Every way this answer can be SHORT, said out loud in the text channel too. A
      // truncated list that does not announce itself reads as complete, and that is the
      // dangerous failure — worse than an error, because it is believed.
      if (omitted > 0) {
        lines.push(
          '',
          `   ⚠️  ${omitted} further member${omitted === 1 ? '' : 's'} NOT shown (limit ${limit}). ` +
            `Re-call with limit: ${Math.min(total, BRANCH_HISTORY_CONFIG.maxLimit)}.`
        );
      }
      if (limitClamped) {
        lines.push(`   ⚠️  Requested limit ${requested} exceeds the ceiling; clamped to ${limit}.`);
      }
      // THE APPROXIMATION, SAID OUT LOUD. Two different admissions, deliberately separate:
      // one about the rows that ARE here, one about rows that may be missing. Presenting a
      // pre-086 count as a fact is the defect this whole round exists to remove.
      if (membership.approximateMembers > 0) {
        lines.push(
          '',
          `   ⚠️  ${membership.approximateMembers} of ${total} member${membership.approximateMembers === 1 ? "'s" : "s'"} ` +
            'branch is INFERRED, not recorded: the write predates migration 086, so its branch ' +
            'was derived from where it attaches. Correct for a directly-attached write; wrong ' +
            'for one made after the branch advanced its tip.'
        );
      }
      if (membership.possiblyIncomplete) {
        lines.push(
          '',
          '   ⚠️  This list may be INCOMPLETE. A pre-086 write attaches to a member of this ' +
            'branch, and that record was either written here (on the tip) or on a branch of ' +
            'its own — the data does not say which, so it is not counted. Records written ' +
            'after 086 carry their own branch and are never in doubt.'
        );
      }
      // BAND 3 — THE SEAM, SAID OUT LOUD. These are NOT members and are deliberately not in
      // the list above; admitting them would turn an under-count into an over-count, which is
      // SK2 round 1's defect. But they are the visible edge of the cohort whose membership was
      // destroyed before migration 086 (the positional mint losing its triple to a tag mint),
      // and a seam nobody can see is a seam nobody will fix.
      if (membership.tagOnlyNoPosition > 0) {
        lines.push(
          '',
          `   ⚠️  ${membership.tagOnlyNoPosition} further record` +
            `${membership.tagOnlyNoPosition === 1 ? '' : 's'} TAG this spine but carry no ` +
            'recorded position, so whether they were written here is UNKNOWN and they are not ' +
            'counted as members. Positions are hard-deleted on branch_close, so for a pre-086 ' +
            'write nothing survives that could say. NOT guessed — and no longer a dead end: ' +
            'an author who knows can DECLARE it with branch_assign({id, spine}), which makes ' +
            'the record a member and drains it from this band.' // trust-render-exempt: BAND 3 is a MEMBERSHIP band (tag-only, no recorded position), not a trust band — renders no trust verdict
        );
        if (membership.tagOnlyNoPositionIds.length > 0) {
          lines.push(
            `      candidates: ${membership.tagOnlyNoPositionIds.map((i) => i.substring(0, 8)).join(', ')}` +
              (membership.tagOnlyIdsTruncated
                ? ` (${membership.tagOnlyNoPosition - membership.tagOnlyNoPositionIds.length} more not listed)`
                : '')
          );
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          action: 'history',
          spine: {
            id: spine.spineId,
            type: spine.spineType,
            title: spineTitle,
            url: recordUrl(spine.spineId),
          },
          members,
          // memberCount counts THIS RESPONSE's array — a count that can disagree with the
          // list beside it is a lie waiting to happen. `totalMembers` is the branch's size.
          memberCount: members.length,
          totalMembers: total,
          omitted,
          open,
          // TRUNCATED means "this RESPONSE is short of the branch": paging, and nothing else
          // now that the walk and its two caps are gone. It is deliberately NOT or-ed with
          // the approximation flags below — those are about how well the branch is KNOWN,
          // and conflating "you asked for 5 of 40" with "one row's branch was inferred"
          // would make a caller re-request instead of reading the caveat.
          truncated: omitted > 0,
          limitUsed: limit,
          // BAND 2, THE HONESTY PAIR (migration 086). approximateMembers counts rows that
          // ARE here whose branch was derived, not recorded; possiblyIncomplete says a row
          // that belongs here may be MISSING. Both are false for any branch written after
          // 086, so a caller can assert "this answer is exact" structurally.
          approximateMembers: membership.approximateMembers,
          possiblyIncomplete: membership.possiblyIncomplete,
          // BAND 3. Records that TAG this spine and carry NO recorded position anywhere —
          // visible, unattributable, and NOT members. Reported as its own number and never
          // merged into memberCount: merging it would over-count (round 1's defect), and
          // dropping it would hide the seam left by the pre-086 dedup that silently unmembered
          // roughly half of every active branch (measured on prod 2026-08-15).
          tagOnlyNoPosition: membership.tagOnlyNoPosition,
          // BAND 3'S IDS (P3) — the DISCOVERY SURFACE for branch_assign,
          // bounded by config so a large band cannot blow the response up. The COUNT above is
          // complete; this list may not be, and `tagOnlyIdsTruncated` is how a caller knows
          // rather than inferring completeness from a length.
          tagOnlyNoPositionIds: membership.tagOnlyNoPositionIds,
          tagOnlyIdsTruncated: membership.tagOnlyIdsTruncated,
          // EXACT IS A FORWARD-ONLY CLAIM. True only when all three bands agree there is
          // nothing inferred and nothing unattributable — which is every branch written after
          // 086, and no branch that straddles it. An earlier draft omitted the third band from
          // this conjunction and so answered `exact:true` over data that provably cannot be
          // exact; that is the same confident-wrong-number defect one level up.
          exact:
            membership.approximateMembers === 0 &&
            !membership.possiblyIncomplete &&
            membership.tagOnlyNoPosition === 0,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'branch_history');
    }
  }

  /**
   * Resolve the RECORD being assigned. Same resolver as the spine — project-scoped, never
   * first-match, all three tables — but its own refusal text: spineResolutionError's message
   * says "a branch must have a REAL spine record", which is the wrong sentence to show
   * someone whose `id` argument was the MEMBER.
   */
  private async resolveMemberRecord(
    rawId: string,
    projectId: string,
    toolName: string
  ): Promise<{ recordId: string; recordType: MemberType } | { error: McpResponse }> {
    const res = await resolveSpineRecord(rawId, projectId);
    if (res.ok) return { recordId: res.spineId, recordType: res.spineType as MemberType };
    if (res.reason === 'spine-not-found') {
      return {
        error: {
          content: [{
            type: 'text',
            text:
              `❌ ${toolName}: '${rawId}' resolves to no context, decision, or task in this ` +
              `project — there is no record to ${toolName === 'branch_unassign' ? 'unassign' : 'assign'}.\n\n` +
              `💡 Check the id (task_list / decision_search / context_search).`,
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected', found: false },
        },
      };
    }
    // Ambiguity refusals read correctly for either argument — reuse them verbatim.
    return { error: spineResolutionError(res, toolName) };
  }

  /** The shared "that membership row belongs to another project" refusal. */
  private foreignRowRefusal(toolName: string, recordId: string): McpResponse {
    return {
      content: [{
        type: 'text',
        text:
          `❌ ${toolName}: the membership row for ${recordId.substring(0, 8)} carries a ` +
          `DIFFERENT project's id. Refusing to move another project's fact.\n\n` +
          `💡 This row was written outside the normal mint (raw SQL, a migration, a service). ` +
          `Fix it where it was written, or unassign it from the project that owns it.`,
      }],
      isError: true,
      structuredContent: { ok: false, action: 'rejected' },
    };
  }

  /**
   * branch_assign — DECLARE which branch a record belongs to, after the fact
   * (P3, migration 090).
   *
   * WHY THIS TOOL EXISTS. Membership used to be write-once: positionalMint inserts
   * ON CONFLICT DO NOTHING, so the FIRST position won and a wrong one could never be
   * corrected. That is right for the mint and wrong as the end of the story, because the
   * system opens positions the author never asked for (auto/byproduct opens) — so the SYSTEM
   * manufactures wrong memberships and nobody could fix them. `branch_history`'s band 3
   * (`tagOnlyNoPosition`) is the precomputed list of the records this resolves, and it drains
   * itself as they are assigned.
   *
   * ONE UPSERT-SHAPED ACTION, covering both first-assign and move. "No row" versus "wrong
   * row" is the STORE's distinction, not the author's intent, and two actions would force a
   * caller to know which case it is in with no way to find out. The response reports which
   * happened (`action: 'assigned' | 'moved' | 'unchanged'` + `previousSpineId`) — the same
   * shape branch_open already uses so a move is visible, never silent.
   *
   * THIS IS THE FIRST TOOL IN THE PRODUCT THAT REWRITES A PREVIOUSLY IMMUTABLE HISTORICAL
   * FACT. What makes that acceptable is `branch_membership_moves`: every change appends a row
   * naming the actor, the branch it left, the branch it joined and when. Any actor scoped to
   * the project may reassign any record in it (the operator's call) — there is no
   * per-record ownership model, consistent with link/unlink — and the audit table is the
   * accountability that buys.
   */
  async handleAssign(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      if (!args.id || !args.spine) {
        return {
          content: [{
            type: 'text',
            text:
              '❌ branch_assign requires BOTH `id` (the record to place) and `spine` (the ' +
              'branch to place it on) — each a context, decision, or task (full UUID or ' +
              '8+-hex short id).\n\n' +
              '💡 branch_history({id: spine}) lists `tagOnlyNoPositionIds` — the records on ' +
              'this spine whose branch nobody has declared yet.',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: '❌ branch_assign: no active project to scope the record and spine against.\n\n' +
                  '💡 project_switch first (or pass projectId).',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const member = await this.resolveMemberRecord(String(args.id), projectId, 'branch_assign');
      if ('error' in member) return member.error;
      const spine = await this.resolveSpine(String(args.spine), projectId, 'branch_assign');
      if ('error' in spine) return spine.error;

      const result = await assignMembership({
        recordId: member.recordId,
        recordType: member.recordType,
        spineId: spine.spineId,
        spineType: spine.spineType,
        projectId,
        actor: context?.actor,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      });

      if (!result.ok) {
        if (result.reason === MEMBERSHIP_WRITE_REFUSAL.selfMembership) {
          return {
            content: [{
              type: 'text',
              text:
                `❌ branch_assign: a record cannot be a member of itself — ` +
                `${member.recordId.substring(0, 8)} IS the spine you named.\n\n` +
                `💡 The spine is the branch; membership is what was written ON it.`,
            }],
            isError: true,
            structuredContent: { ok: false, action: 'rejected' },
          };
        }
        return this.foreignRowRefusal('branch_assign', member.recordId);
      }

      const spineTitle = await this.spineTitle(spine.spineId, spine.spineType);
      const short = spine.spineId.substring(0, 8);
      const lines: string[] = [];
      if (result.outcome === 'moved') {
        lines.push(
          `🌿 Branch membership MOVED. ${member.recordType} ${member.recordId.substring(0, 8)} ` +
            `is now a member of ${spine.spineType} ${short}` +
            `${spineTitle ? ` ("${spineTitle}")` : ''}  ${formatRecordRef(spine.spineId)}`,
          `   (was: ${result.previousSpineId!.substring(0, 8)} — branch_history ` +
            `${result.previousSpineId!.substring(0, 8)} no longer lists it)`
        );
      } else if (result.outcome === 'assigned') {
        lines.push(
          `🌿 Branch membership ASSIGNED. ${member.recordType} ${member.recordId.substring(0, 8)} ` +
            `is now a member of ${spine.spineType} ${short}` +
            `${spineTitle ? ` ("${spineTitle}")` : ''}  ${formatRecordRef(spine.spineId)}`,
          '   (it was a member of no branch before this)'
        );
      } else {
        lines.push(
          `ℹ️  Nothing changed — ${member.recordType} ${member.recordId.substring(0, 8)} was ` +
            `already a member of ${spine.spineType} ${short}. No move was recorded.`
        );
      }
      if (result.outcome !== 'unchanged') {
        lines.push(
          `   Recorded as a DECLARED branch (source: ${MEMBERSHIP_SOURCE.assigned}) — a fact, ` +
            'not an approximation, and logged in branch_membership_moves with your actor id.'
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          ok: true,
          action: result.outcome,
          member: { id: member.recordId, type: member.recordType, url: recordUrl(member.recordId) },
          spine: {
            id: spine.spineId,
            type: spine.spineType,
            title: spineTitle,
            url: recordUrl(spine.spineId),
          },
          // NULL means "it was a member of nothing", which is a different history from "it
          // was on branch X" — the same distinction from_spine_id encodes in the move log.
          previousSpineId: result.previousSpineId,
          // The stored source, echoed so a caller never has to assume what was written.
          // 'unchanged' leaves whatever was already there, so it is reported as null.
          spineSource: result.outcome === 'unchanged' ? null : MEMBERSHIP_SOURCE.assigned,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'branch_assign');
    }
  }

  /**
   * branch_unassign — remove a record's branch membership, and leave the trace.
   *
   * SHIPPED WITH branch_assign, NOT AFTER IT, and that is a correctness argument rather than
   * a convenience one: auto/byproduct positions open WITHOUT the author asking, so the system
   * creates memberships nobody declared. With assign alone, the only correction available is
   * replacing one wrong fact with a different wrong fact — there is no way to say "this
   * record belongs to no branch", which is frequently the true answer.
   *
   * The membership ROW is deleted; the EVENT is not. `branch_membership_moves` keeps a row
   * with `to_spine_id IS NULL`, which is the one event no previous_spine_id column could ever
   * have represented (after a removal there is no row left to carry the column) — and the
   * reason that table carries no foreign key back to `branch_memberships`.
   */
  async handleUnassign(args: any, context?: RouteContext): Promise<McpResponse> {
    try {
      if (!args.id) {
        return {
          content: [{
            type: 'text',
            text:
              '❌ branch_unassign requires `id` — the record whose branch membership to ' +
              'remove (context, decision, or task; full UUID or 8+-hex short id).\n\n' +
              '💡 The record is not deleted and its edges are untouched; only the membership ' +
              'row goes, and the removal is logged.',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const projectId = await this.resolveProjectId(args.projectId, context);
      if (!projectId) {
        return {
          content: [{
            type: 'text',
            text: '❌ branch_unassign: no active project to scope the record against.\n\n' +
                  '💡 project_switch first (or pass projectId).',
          }],
          isError: true,
          structuredContent: { ok: false, action: 'rejected' },
        };
      }

      const member = await this.resolveMemberRecord(String(args.id), projectId, 'branch_unassign');
      if ('error' in member) return member.error;

      const result = await removeMembership({
        recordId: member.recordId,
        projectId,
        actor: context?.actor,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
      });

      if (!result.ok) return this.foreignRowRefusal('branch_unassign', member.recordId);

      const shortId = member.recordId.substring(0, 8);
      return {
        content: [{
          type: 'text',
          text:
            result.outcome === 'unassigned'
              ? `🌿 Branch membership REMOVED. ${member.recordType} ${shortId} is no longer a ` +
                `member of ${result.previousSpineId!.substring(0, 8)}; it is a member of no ` +
                `branch.\n` +
                '   The record and its edges are untouched. The removal is logged in ' +
                'branch_membership_moves with your actor id, so the branch it left is still ' +
                'recoverable.'
              : `ℹ️  ${member.recordType} ${shortId} was a member of no branch — nothing to ` +
                'remove, and nothing was logged.',
        }],
        structuredContent: {
          ok: true,
          action: result.outcome,
          member: { id: member.recordId, type: member.recordType, url: recordUrl(member.recordId) },
          previousSpineId: result.previousSpineId,
        },
      };
    } catch (error) {
      return formatMcpError(error as Error, 'branch_unassign');
    }
  }
}

export const branchRoutes = new BranchRoutes();
