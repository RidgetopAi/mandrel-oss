/**
 * HANDOFF CARRIED FIELDS — the write half and the read half of `mode` + `spine` (P5.4).
 * The rule, the vocabulary and every string live in config/handoffCarriedFieldsConfig.ts;
 * this module is the only reader of them.
 *
 * ═══ THE CONTRACT: WARN AND STORE. NEVER REJECT. ════════════════════════════════════════
 * Nothing in this file throws and nothing in it can fail a write. That is not politeness,
 * it is a ranking of harms: LOSING A HANDOFF IS CATASTROPHIC — it is the record three
 * separate systems resolve "where am I" through — and STORING AN ODD MODE IS NOT. A
 * handoff must never fail to store because its mode was spelled in a way this deployment
 * has not heard of. Matches the stated contract of utils/threadingTags.ts ("NEVER throws,
 * NEVER rejects, NEVER drops") and of services/handoffResumePointer.ts.
 *
 * Every normalisation, truncation, non-recognition and drop is REPORTED to the caller
 * (`warnings`), because a server mutating a caller's data silently is how a convention
 * becomes folklore.
 *
 * ═══ PRECEDENCE: THE FIELD BEATS THE PROSE ══════════════════════════════════════════════
 * A handoff carrying BOTH a stored `mode` field and a `MODE:` line in its body renders the
 * FIELD, labelled `[source: field]`.
 *
 * WHY, and it is not merely "the newer mechanism wins":
 *   - The field is the caller's DECLARED intent, expressed through a typed parameter they
 *     had to name. The prose match is an INFERENCE about a sentence — a regex cannot tell
 *     `MODE: build` from `MODE: build was wrong, we are debugging` from a quoted example
 *     of someone else's handoff pasted into the body. One of those is a declaration; the
 *     others are text that happens to match.
 *   - It is the same ladder the rest of this product already runs on: declared outranks
 *     inferred, everywhere. positionalMint's `declared` position outranks a scraped id
 *     (positionalMint.ts:739); the trust model refuses to let a guessed `supersedes`
 *     contradict a declared chain (P5.3); handoffHead walks `tier='declared'` edges only.
 *     A field-vs-prose ladder that ran the other way would be the one place in Mandrel
 *     where a guess outranks a declaration.
 * The render LABELS the source on every line, so the precedence is legible rather than
 * something a reader has to know.
 *
 * ═══ THE PROSE FALLBACK IS NOT A COMPATIBILITY SHIM, IT IS THE COMMON CASE ══════════════
 * Our own entire corpus — every handoff we have ever written — is prose-only, and so is
 * every handoff any existing customer has stored. This is not a flag day and there is no
 * backfill: a handoff with no field reads exactly as it read before P5.4. The regex ported
 * below is a faithful port of riverbend/runtime/lib/handoff-fields.sh, including the two
 * defects that shell learned the hard way (the markdown-heading form, and backticks around
 * the spine id), so the fallback is at least as good as the shell it replaces.
 *
 * ═══ THE SYNC/ASYNC SEAM — the same one handoffStamp.ts is split at ═══════════════════
 *   applyCarriedFields()  — PURE. The WRITE path. No pool, no clock.
 *   readCarriedFields()   — PURE. Field-vs-prose resolution. No pool, no clock.
 *   resolveCarriedSpine() — ASYNC, DB-reading. Runs in gatherBriefingData ONLY.
 * The briefing RENDERER stays a pure function of (data, config, now), which is the
 * property every existing briefing test depends on; a DB read inside it would cost that.
 *
 * Spine EXISTENCE is measured at RENDER time and never at write time, deliberately: a
 * spine resolved on write would be a snapshot claim that decays the moment the record is
 * renamed or archived, and the reader needs today's truth, not the author's. The write
 * path's spine check is SYNTACTIC only, and says so in its warning.
 */

import {
  CARRIED_FIELDS_CONTEXT_TYPE,
  CARRIED_FIELDS_METADATA_KEY,
  CARRIED_FIELDS_MODE_KEY,
  CARRIED_FIELDS_MODE_MAX_CHARS,
  CARRIED_FIELDS_NOTE_NORMALIZED,
  CARRIED_FIELDS_NOTE_OVERWROTE,
  CARRIED_FIELDS_NOTE_SPINE_SHAPE,
  CARRIED_FIELDS_NOTE_TRUNCATED,
  CARRIED_FIELDS_NOTE_UNRECOGNISED_MODE,
  CARRIED_FIELDS_NOTE_WRONG_TYPE,
  CARRIED_FIELDS_SPINE_KEY,
  CARRIED_FIELDS_SPINE_UNKNOWN_KIND,
  READ_HANDOFF_MODE_VOCABULARY,
} from '../config/handoffCarriedFieldsConfig.js';
import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  isUuidOrShortId,
  resolveMintEndpoint,
  type ResolvableEntity,
} from '../utils/idResolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// WRITE HALF
// ─────────────────────────────────────────────────────────────────────────────

/** The carried fields exactly as a caller supplied them, before normalisation. */
export interface CarriedFieldsArgs {
  mode?: string;
  spine?: string;
}

/** The honest report of what the carried-fields layer did for one write. */
export interface CarriedFieldsReport {
  /** The mode as STORED (normalized), or null when none was supplied. */
  mode: string | null;
  /**
   * Whether the stored mode is in this deployment's recognised vocabulary. `null` when no
   * mode was supplied — deliberately tri-state, so "no mode" is never readable as
   * "an unrecognised mode" (C1: could-not-measure gets its own value, not a `false`).
   */
  modeRecognised: boolean | null;
  /** The spine reference as STORED (trimmed, lower-cased), or null when none was supplied. */
  spine: string | null;
  /**
   * Whether the stored spine is SHAPED like a resolvable id. This is a syntactic claim
   * ONLY — it does not say the record exists. Existence is measured at render time.
   * `null` when no spine was supplied.
   */
  spineResolvable: boolean | null;
  /** The `contexts.metadata` path the fields were written to, so no consumer needs a literal. */
  storedAt: string;
}

/** What applyCarriedFields hands back. */
export interface CarriedFieldsApplication {
  /** The metadata object to store — the caller's, with the reserved namespace merged in. */
  metadata: Record<string, any> | undefined;
  /** null for every non-handoff type, and for a handoff that supplied neither field. */
  report: CarriedFieldsReport | null;
  /** Caller-facing notes. Empty on a clean store. */
  warnings: string[];
}

/**
 * Normalize a mode label: trim, lower-case, collapse runs of whitespace/underscores to a
 * single hyphen. So `Define To Lock`, `define_to_lock` and `  DEFINE-TO-LOCK ` all land on
 * `define-to-lock` and stop producing spurious "unrecognised" notes for the same idea.
 *
 * The SAME normalisation is applied whether or not the result is recognised — a value we
 * do not know is still stored in a canonical shape so it is groupable, searchable and
 * comparable. Normalising only the recognised half would make the vocabulary decide the
 * data's shape, which is the tail wagging the dog.
 */
function normalizeMode(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Apply the carried fields to a write's metadata.
 *
 * @param contextType the type as it will be written (only `handoff` is affected).
 * @param metadata    the caller's metadata object, or undefined.
 * @param args        the caller's `mode` / `spine` arguments.
 *
 * GATED TO `handoff`, and a mode/spine on any other type is DROPPED WITH A WARNING rather
 * than stored. Nothing reads these fields off a `type:code` record — storing them there
 * would manufacture metadata that looks meaningful and is inert, which is worse than a
 * note telling the caller exactly where the fields belong. Same gate the resume pointer
 * and the supersession mint already apply, imported rather than re-spelled.
 */
export function applyCarriedFields(
  contextType: string,
  metadata: Record<string, any> | undefined,
  args: CarriedFieldsArgs,
): CarriedFieldsApplication {
  const rawMode = typeof args.mode === 'string' ? args.mode : undefined;
  const rawSpine = typeof args.spine === 'string' ? args.spine : undefined;
  const supplied = (rawMode !== undefined && rawMode.trim() !== '')
    || (rawSpine !== undefined && rawSpine.trim() !== '');

  if (!supplied) return { metadata, report: null, warnings: [] };

  if (contextType !== CARRIED_FIELDS_CONTEXT_TYPE) {
    return {
      metadata,
      report: null,
      warnings: [CARRIED_FIELDS_NOTE_WRONG_TYPE(contextType, CARRIED_FIELDS_CONTEXT_TYPE)],
    };
  }

  const warnings: string[] = [];
  const carried: Record<string, any> = {};

  let mode: string | null = null;
  let modeRecognised: boolean | null = null;
  if (rawMode !== undefined && rawMode.trim() !== '') {
    mode = normalizeMode(rawMode);
    if (mode !== rawMode) warnings.push(CARRIED_FIELDS_NOTE_NORMALIZED(rawMode, mode));
    if (mode.length > CARRIED_FIELDS_MODE_MAX_CHARS) {
      mode = mode.slice(0, CARRIED_FIELDS_MODE_MAX_CHARS);
      warnings.push(CARRIED_FIELDS_NOTE_TRUNCATED(CARRIED_FIELDS_MODE_MAX_CHARS));
    }
    const vocabulary = READ_HANDOFF_MODE_VOCABULARY();
    modeRecognised = vocabulary.includes(mode);
    // WARN AND STORE. The write proceeds identically either way — the note is the entire
    // consequence of being outside the vocabulary.
    if (!modeRecognised) warnings.push(CARRIED_FIELDS_NOTE_UNRECOGNISED_MODE(mode, vocabulary));
    carried[CARRIED_FIELDS_MODE_KEY] = mode;
  }

  let spine: string | null = null;
  let spineResolvable: boolean | null = null;
  if (rawSpine !== undefined && rawSpine.trim() !== '') {
    spine = rawSpine.trim().toLowerCase();
    // SYNTACTIC ONLY, and said so in the note: `isUuidOrShortId` answers "could anything
    // resolve from this string", not "does that record exist". The existence question is
    // asked at RENDER time against today's database — see the header.
    spineResolvable = isUuidOrShortId(spine);
    if (!spineResolvable) warnings.push(CARRIED_FIELDS_NOTE_SPINE_SHAPE(spine));
    carried[CARRIED_FIELDS_SPINE_KEY] = spine;
  }

  // MERGE, never replace: the caller's own metadata is untouched apart from the two
  // reserved keys, and a caller who ALSO wrote those keys by hand is told the explicit
  // argument won rather than discovering it later.
  const existing = metadata?.[CARRIED_FIELDS_METADATA_KEY];
  const existingCarried = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? (existing as Record<string, any>)
    : {};
  for (const key of Object.keys(carried)) {
    if (existingCarried[key] !== undefined && existingCarried[key] !== carried[key]) {
      warnings.push(CARRIED_FIELDS_NOTE_OVERWROTE(key));
    }
  }

  return {
    metadata: {
      ...(metadata ?? {}),
      [CARRIED_FIELDS_METADATA_KEY]: { ...existingCarried, ...carried },
    },
    report: {
      mode,
      modeRecognised,
      spine,
      spineResolvable,
      storedAt: `metadata.${CARRIED_FIELDS_METADATA_KEY}`,
    },
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// READ HALF — field first, prose second, "(none recorded)" third.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a rendered carried field came from. Always labelled in the output. */
export type CarriedFieldSource = 'field' | 'prose';

export interface CarriedFieldValue {
  value: string;
  source: CarriedFieldSource;
}

/** A spine reference plus where it came from. `kind` is what the SOURCE claimed, if anything. */
export interface CarriedSpineRef {
  ref: string;
  /** The type word the source named (`task`/`decision`/`context`), or the unknown-kind word. */
  kind: string;
  source: CarriedFieldSource;
}

/**
 * The three carried values a handoff can render. Every field is explicitly nullable and
 * `null` means MEASURED ABSENT — neither a stored field nor parseable prose carried it.
 */
export interface CarriedFields {
  mode: CarriedFieldValue | null;
  /**
   * The full PATH narrative. PROSE ONLY, forever — see CARRIED_FIELDS_PATH_LABEL. There is
   * no field that could populate it and inventing one from a spine id would fabricate a
   * sentence the author never wrote.
   */
  path: CarriedFieldValue | null;
  spine: CarriedSpineRef | null;
}

/** What a handoff carrying nothing at all reports. A claim, not a default. */
export const NO_CARRIED_FIELDS: CarriedFields = Object.freeze({
  mode: null,
  path: null,
  spine: null,
});

/**
 * Pull a carried field out of a handoff's PROSE — the fallback path.
 *
 * A FAITHFUL PORT of extract_field() in riverbend/runtime/lib/handoff-fields.sh, whose
 * header records why each form is accepted. The forms are the ones OBSERVED live in the
 * handoff corpus, not the ones someone imagined:
 *     heading : `## MODE: build`      (any 1-6 leading `#`)
 *     bare    : `MODE: build`
 *     bold    : `**MODE:** build` or `**MODE**: build`
 * The heading form is not a nicety: a bare `^MODE:` grep silently never matched it, so the
 * read-back trip-wire degraded to "none recorded" on handoffs that plainly carried a mode.
 * A trip-wire that silently never fires is worse than none.
 *
 * `(.+)` requires a NON-EMPTY value, so a bare `MODE:` with nothing after it is ABSENT
 * rather than a spurious match — the fix must not manufacture a value.
 */
export function extractProseField(field: string, text: string): string | null {
  const re = new RegExp(
    `^[ \\t]*#*[ \\t]*\\**[ \\t]*${field}\\**[ \\t]*:\\**[ \\t]*(.+)$`,
    'm',
  );
  const m = re.exec(text ?? '');
  if (!m) return null;
  const value = m[1].replace(/\s+$/, '');
  return value.length > 0 ? value : null;
}

/**
 * Pull the SPINE out of a prose PATH line's `(spine [<type>] <id8>)` clause.
 *
 * Ported from extract_path_spine() in handoff-fields.sh, including both defects that shell
 * paid for in production:
 *   - THE TYPE WORD IS OPTIONAL. The live corpus writes it both ways, and refusing the
 *     typeless form made a boot report "the PATH line named no spine id" — a sentence that
 *     was false about the data and true only about the regex.
 *   - BACKTICKS ARE STRIPPED BEFORE MATCHING. Our house style renders every id in
 *     backticks, so ```` was refused; the cost was silent and total (no
 *     spine, no branch walk, every record rendered `[branch:unknown]`). Stripping is not a
 *     widening: a backtick is markdown decoration and never part of an id, so removing it
 *     cannot manufacture a match that was not textually there.
 *
 * WHAT IT STILL REFUSES, deliberately: an UNRECOGNISED word where the type belongs
 * (`(spine session e6170769)` does not match — the id8 window must start immediately after
 * `(spine ` or after a recognised type word). And it NEVER guesses a spine from a
 * `branch:<slug>` name: a slug is a name, not an id, and an auto-open onto a guessed spine
 * is exactly the confidently-wrong declared edge this work exists to prevent.
 */
export function extractProseSpine(pathValue: string): { ref: string; kind: string } | null {
  const lower = (pathValue ?? '').toLowerCase().replace(/`/g, '');
  const m = /\(spine\s+((task|decision|context)\s+)?([0-9a-f]{8})([^-0-9a-f]|$)/.exec(lower);
  if (!m) return null;
  return { ref: m[3], kind: m[2] ?? CARRIED_FIELDS_SPINE_UNKNOWN_KIND };
}

/**
 * Resolve the carried fields for ONE handoff: stored field first, prose second, absent
 * third. PURE — no clock, no pool, no env beyond the config module.
 *
 * @param metadata the stored `contexts.metadata` object (any shape; hostile input is fine).
 * @param content  the handoff body, for the fallback.
 *
 * Note the two halves are resolved INDEPENDENTLY: a handoff carrying a `mode` field and a
 * prose PATH renders the field's mode AND the prose path, each with its own source label.
 * Falling back all-or-nothing would discard a real value because a different one existed.
 */
export function readCarriedFields(
  metadata: unknown,
  content: string,
): CarriedFields {
  const bag = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, any>)[CARRIED_FIELDS_METADATA_KEY]
    : undefined;
  const carried = bag && typeof bag === 'object' && !Array.isArray(bag)
    ? (bag as Record<string, any>)
    : undefined;

  // MODE — field wins over prose. See the header for why declared outranks inferred.
  let mode: CarriedFieldValue | null = null;
  const fieldMode = carried?.[CARRIED_FIELDS_MODE_KEY];
  if (typeof fieldMode === 'string' && fieldMode.trim() !== '') {
    mode = { value: fieldMode.trim(), source: 'field' };
  } else {
    const prose = extractProseField('MODE', content);
    if (prose !== null) mode = { value: prose, source: 'prose' };
  }

  // PATH — prose only, always. There is no field for it and there must not be one.
  const prosePath = extractProseField('PATH', content);
  const path: CarriedFieldValue | null =
    prosePath !== null ? { value: prosePath, source: 'prose' } : null;

  // SPINE — field wins; the prose fallback reads the PATH line's `(spine …)` clause.
  let spine: CarriedSpineRef | null = null;
  const fieldSpine = carried?.[CARRIED_FIELDS_SPINE_KEY];
  if (typeof fieldSpine === 'string' && fieldSpine.trim() !== '') {
    // The FIELD names no kind — that is what makes it a reference rather than a claim. The
    // kind printed is the unknown-kind word until the renderer measures it against the DB.
    spine = {
      ref: fieldSpine.trim().toLowerCase(),
      kind: CARRIED_FIELDS_SPINE_UNKNOWN_KIND,
      source: 'field',
    };
  } else if (prosePath !== null) {
    const fromProse = extractProseSpine(prosePath);
    if (fromProse) spine = { ...fromProse, source: 'prose' };
  }

  return { mode, path, spine };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER-TIME RESOLUTION — what that spine reference actually names, TODAY.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The KINDS a spine may name, in the order they are probed. A spine can be a task, a
 * decision OR a context — the P5.4 brief is explicit that it must not be restricted to
 * tasks, and the live corpus agrees: `branch_open` takes an id8 and accepts any spine kind.
 *
 * `session` is NOT in this list even though idResolver can resolve one. A session is a
 * runtime artifact, not a record anyone hands forward as a place to stand, and admitting
 * it would let an 8-hex prefix collide into a kind no branch can be opened on.
 */
const SPINE_KINDS: readonly ResolvableEntity[] = Object.freeze(['task', 'decision', 'context']);

/** What a spine reference resolves to, measured against today's database. */
export interface ResolvedSpine {
  /** The kind the record ACTUALLY is — measured, never the kind the prose claimed. */
  kind: ResolvableEntity;
  /** A short human handle: a title for a task/decision, a type+snippet for a context. */
  title: string;
}

/**
 * Resolve a spine reference to the record it names, project-scoped, across all three
 * spine kinds. Returns `null` when it names nothing resolvable here.
 *
 * NEVER THROWS. This runs on the boot path of every briefing; a resolver hiccup must cost
 * the reader a label, not the whole handoff — the same contract resolveHandoffStamps keeps.
 *
 * THE AMBIGUITY RULE, inherited rather than re-decided: an id8 matching more than one
 * record RESOLVES TO NOTHING (resolveMintEndpoint throws AmbiguousIdError and never
 * first-matches). A confident WRONG title on a spine is worse than no
 * title, because the reader would then `branch_open` onto the wrong record.
 *
 * THE CROSS-KIND RULE: probing stops at the FIRST kind that resolves. A reference that
 * resolves in two different kinds is a real (if remote) collision, and it is bounded the
 * same way everything else here is — the kind order is FIXED and named above, so the
 * outcome is deterministic rather than dependent on query timing.
 */
export async function resolveCarriedSpine(
  ref: string,
  projectId: string,
  pool: Pool = db,
): Promise<ResolvedSpine | null> {
  if (!isUuidOrShortId(ref)) return null;
  for (const kind of SPINE_KINDS) {
    try {
      const id = await resolveMintEndpoint(kind, ref, projectId, pool);
      // The label read is a SEPARATE id-keyed lookup rather than something folded into the
      // resolver: `archived_at` is not the resolver's business — it resolves ids, it does
      // not decide what a caller considers live. The table name is chosen from the fixed
      // SPINE_KINDS vocabulary and is never user input; $1 is BOUND.
      const row = kind === 'context'
        ? (await pool.query(
            'SELECT context_type AS kind_label, content AS body FROM contexts' +
              ' WHERE id = $1 AND archived_at IS NULL',
            [id],
          )).rows[0]
        : (await pool.query(
            `SELECT title AS kind_label, NULL AS body FROM ${kind === 'task' ? 'tasks' : 'technical_decisions'}` +
              ' WHERE id = $1 AND archived_at IS NULL',
            [id],
          )).rows[0];
      // Archived, or resolved-then-vanished (a delete racing the render). Either way it is
      // NOT a record the reader can stand on, so it reports as unresolved rather than as a
      // live spine — the render then says so in band.
      if (!row) continue;
      const title = kind === 'context'
        ? `${row.kind_label}: ${String(row.body ?? '').replace(/\s+/g, ' ').trim()}`
        : String(row.kind_label ?? '').replace(/\s+/g, ' ').trim();
      return { kind, title };
    } catch {
      // AmbiguousIdError -> never first-match (see the header): treat as unresolved.
      // IdNotFoundError  -> this kind does not have it; try the next.
      // Anything else    -> a resolver hiccup must not take the briefing down.
      continue;
    }
  }
  return null;
}
