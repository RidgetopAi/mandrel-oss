import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { contextHandler } from './context.js';
import { decisionsHandler } from './decisions.js';
import { codeAnalysisHandler } from './codeAnalysis.js';
import {
    HEALTH_SCORE_CEILING,
    HEALTH_SCORE_FLOOR,
    HEALTH_AVG_COMPLEXITY_WEIGHT,
    HEALTH_MAX_COMPLEXITY_THRESHOLD,
    HEALTH_MAX_COMPLEXITY_PENALTY,
    HEALTH_LEVEL_HEALTHY_MAX,
    HEALTH_LEVEL_MODERATE_MAX,
    HEALTH_HIGH_COMPLEXITY_ISSUE_THRESHOLD,
    HEALTH_LEVEL_NO_DATA,
} from '../config/insightsConfig.js';
import { buildProjectCoverage } from '../services/projectCoverage.js';
import { RANK_WEIGHTS, unifiedScore } from '../config/rankingConfig.js';
import {
    SMART_SEARCH_DEFAULT_SOURCES,
    SEARCH_MERGE_OVERFETCH_FACTOR,
    SEARCH_MERGE_MIN_PER_SOURCE,
    SEARCH_SOURCE_WEIGHTS,
    SEARCH_MERGE_APPLY_RECENCY_PROFILE,
    DECISION_IMPACT_IMPORTANCE,
    DECISION_IMPACT_IMPORTANCE_DEFAULT,
    DECISION_TYPE_WEIGHT,
    TASK_TYPE_WEIGHT,
    taskImportance,
} from '../config/searchMergeConfig.js';
import { SEARCH_ID_MATCH_SCORE_BOOST } from '../config/searchConfig.js';
import {
  deriveRecordHeadline,
  deriveTypedRecordHeadline,
} from '../config/recordHeadlineConfig.js';
import { tasksHandler } from './tasks.js';
import { LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';
import { HYBRID_SEARCH_CONFIG, maxFusedScore } from '../config/hybridSearchConfig.js';
import { runLexicalSearch, type LexicalRow, type LexicalSearchResult } from '../services/lexicalSearch.js';
import { fuseByRank, type RankedChannel } from '../services/rankFusion.js';
import { findAbsentTerms } from '../services/absentTerms.js';
import { decideEmptyState, reconcileWithResolvedRecords, vocabularyOf, type EmptyStateVerdict } from '../services/absentTermVeto.js';

/**
 * Width of the already-derived title echoed into the debug ranking log. This is a LOG LINE
 * budget (keep one ranked row on one terminal line), deliberately NOT the record-headline
 * budget in config/recordHeadlineConfig.ts — see the exemption note at the call site.
 */
const DEBUG_LOG_TITLE_CHARS = 50;

export interface SmartSearchResult {
    type: 'context' | 'component' | 'decision' | 'task' | 'agent';
    id: string;
    title: string;
    summary: string;
    relevanceScore: number;
    metadata: Record<string, any>;
    source: string;
}

/** smart_search's full answer: the merged rows plus everything the caller needs to read them. */
export interface SmartSearchOutcome {
    results: SmartSearchResult[];
    /** Sources that THREW during this call. Empty on a fully healthy search. */
    degradedSources: string[];
    /**
     * BUILD 3 — the query terms that occur in ZERO records of this project, ALWAYS reported.
     * Present on a full result set as readily as on an empty one; that is the point. `null`
     * only when the lexical layer did not run at all (flag off, or the query was skipped),
     * which is a different statement from "nothing was absent" (an empty array).
     */
    absentTerms: EmptyStateVerdict['absentTerms'] | null;
    /**
     * WHY THERE ARE NO ROWS, when there are none. THREE empty states exist and a caller must
     * be able to tell them apart:
     *   'no_match'      — the search ran, everything was readable, nothing matched
     *   'absent_terms'  — we have no record of a specific word; `vetoedBy` names it
     *   'all_degraded'  — every source threw; this is a FAILURE wearing an empty's clothes
     * Null whenever rows were returned.
     */
    emptyReason: null | { kind: 'no_match' | 'absent_terms' | 'all_degraded'; vetoedBy: readonly string[] };
    /** Set when the lexical channel was skipped for this query. See runLexicalSearch(). */
    lexicalSkipped: LexicalSearchResult['skipped'];
}

/** A pooled row awaiting the global sort. `score` is the unified, cross-source quantity. */
interface MergeCandidate {
    sourceKey: string;
    score: number;
    createdAt: Date | string | null;
    result: SmartSearchResult;
    /**
     * Did this row match the caller's query by its OWN id or tag — the exact-lookup path
     * (SEARCH_ID_MATCH_SCORE_BOOST)?
     *
     * P2b needs this as a FACT rather than as an amount buried in the score, because rank
     * fusion throws scores away. MEASURED: with the identifier tier added and this flag
     * missing, the bare-id query `4a460692` fell from rank 1 to rank 4 — records that MENTION
     * that id8 in their text took the identifier tier, while the record whose id IS 4a460692
     * does not contain its own id in its text and so had no identifier hit at all. See the
     * tier ladder in fuseWithLexical().
     */
    idTagHit?: boolean;
}

interface SourceAdapter {
    key: string;
    fetch: (projectId: string, query: string, overfetch: number, nowMs: number) => Promise<MergeCandidate[]>;
}

function candidateTimeMs(c: MergeCandidate): number {
    if (!c.createdAt) return 0;
    const t = c.createdAt instanceof Date ? c.createdAt.getTime() : new Date(c.createdAt).getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * TOTAL ORDER over the pool: score DESC, then created_at DESC, then id ASC.
 *
 * The `id` term is not decoration. Two rows can tie on score AND date (bulk-recorded
 * decisions routinely share a date), and Postgres leaves the relative order of tied rows
 * undefined — so without a final deterministic term the same query can return different
 * top-k on different runs, which makes every ranking guard flaky and every RED
 * unfalsifiable.
 */
function compareCandidates(a: MergeCandidate, b: MergeCandidate): number {
    if (b.score !== a.score) return b.score - a.score;
    const ta = candidateTimeMs(a), tb = candidateTimeMs(b);
    if (tb !== ta) return tb - ta;
    return a.result.id < b.result.id ? -1 : a.result.id > b.result.id ? 1 : 0;
}

/**
 * Pool → sorted → top `limit`, with the OPT-IN floor pass.
 *
 * The floor is OFF by default (SEARCH_MERGE_MIN_PER_SOURCE = 0) and the whole block below
 * is then unreachable: the shipped behaviour is a pure global sort. See that constant for
 * why a guaranteed row per source is the constant-bonus bug wearing a structural hat.
 */
export function mergeCandidates(pool: MergeCandidate[], limit: number,
                                minPerSource: number = SEARCH_MERGE_MIN_PER_SOURCE): SmartSearchResult[] {
    const sorted = [...pool].sort(compareCandidates);
    const selected = sorted.slice(0, limit);

    const sourcesWithCandidates = new Set(pool.map(c => c.sourceKey));
    // SKIP THE FLOOR ENTIRELY when it is disabled, or when there are not enough slots to
    // honour it — with fewer slots than sources the floor has no legal solution and
    // "evict until satisfied" would loop or thrash.
    if (minPerSource > 0 && limit >= sourcesWithCandidates.size * minPerSource) {
        // Deterministic iteration order: source name. An eviction order that depends on
        // Set/Map insertion order is an eviction order that depends on which source
        // happened to answer first, which makes the guard on this flaky.
        const deficits = [...sourcesWithCandidates].sort();
        for (const key of deficits) {
            while (selected.filter(c => c.sourceKey === key).length < minPerSource) {
                const nextIn = sorted.find(c => c.sourceKey === key && !selected.includes(c));
                if (!nextIn) break;
                // Evict the lowest-scoring row of the MOST over-represented source — and
                // never one that would push its own source below its floor, or the
                // eviction re-triggers the condition it just satisfied.
                const evictable = selected
                    .filter(c => c.sourceKey !== key
                        && selected.filter(x => x.sourceKey === c.sourceKey).length > minPerSource)
                    .sort((x, y) => {
                        const nx = selected.filter(c => c.sourceKey === x.sourceKey).length;
                        const ny = selected.filter(c => c.sourceKey === y.sourceKey).length;
                        if (ny !== nx) return ny - nx;
                        return compareCandidates(y, x); // lowest-scoring first
                    });
                const victim = evictable[0];
                if (!victim) break;
                selected.splice(selected.indexOf(victim), 1);
                selected.push(nextIn);
            }
        }
    }

    return selected.sort(compareCandidates).map(c => c.result);
}

/**
 * A lexical-only row, as a merge candidate.
 *
 * `score` is 0 ON PURPOSE and it is not a claim that the row is irrelevant. Under rank
 * fusion the ordering quantity is the FUSED score, and this field survives only as input to
 * the final tie-break (compareCandidates: score, then created_at, then id). A lexical-only
 * row has no cosine and no four-signal blend, and inventing one — the "constant 0.6" that was
 * defect D1 — is precisely how a made-up base score came to outrank every real context. Zero
 * says "this channel computed no comparable score", and the fused rank above it is what
 * actually decides where the row lands. Rows the SEMANTIC pool also returned never reach this
 * function; they keep their real score and their real source label.
 */
function lexicalRowToCandidate(r: LexicalRow): MergeCandidate {
    return {
        sourceKey: `lexical:${r.kind}`,
        score: 0,
        createdAt: r.createdAt,
        result: {
            type: r.kind,
            id: r.id,
            title: r.title,
            summary: r.summary,
            relevanceScore: 0,
            metadata: r.meta as Record<string, any>,
            source: 'lexical_search',
        },
    };
}

export interface Recommendation {
    type: 'naming' | 'pattern' | 'decision' | 'refactor' | 'task';
    title: string;
    description: string;
    confidence: number;
    actionable: boolean;
    references: string[];
    metadata: Record<string, any>;
}

// EXPORTED for test pool-injection: the fail-loud contract — "if the
// underlying data cannot be read, ERROR, never return a zero" — is only provable by
// binding a handler to a pool whose task query fails. The shipped singleton below is
// still the single instance the product uses.
export class SmartSearchHandler {
    constructor(private pool: Pool = db) {}

    /**
     * ONE MERGED, GLOBALLY-SORTED RESULT SET.
     *
     * WHAT THIS REPLACED, AND WHY (defects D1/D2/D4, measured on prod 2026-08-18 — the
     * baseline was record-hit@1 0/10, record-hit@5 2/10, with 19 of 20 top-2 slots taken
     * by decisions):
     *
     *  D1 SCORE DISCARD. Decisions were re-scored HERE from a constant base 0.6 plus
     *     word-match bonuses, throwing away the real hybrid score decision_search had
     *     already computed. Contexts were scored on raw `similarity` — cosine*100 plus up
     *     to +40 of JS substring boost — which is NOT the key the SQL sorted them by.
     *     Context cosines run 0.32-0.67, so a 0.6 floor outranked nearly every context
     *     arithmetically, regardless of what the query was about. Both formulas are gone:
     *     every source now reports the SAME quantity, the balanced four-signal blend.
     *  D2 SUB-LIMIT TRUNCATION. Per-source quotas (⌈limit/2⌉ + ⌈limit/4⌉ + ⌈limit/4⌉)
     *     fetched 7 candidates to fill 5 slots and truncated each source INSIDE its SQL,
     *     before any cross-source comparison existed. Two probe questions had their
     *     correct record at within-source rank 4 and 5 and were cut before scoring — no
     *     scoring fix reaches them. Sources are now over-fetched
     *     (limit × SEARCH_MERGE_OVERFETCH_FACTOR) and the cut happens ONCE, at the end.
     *  D4 DEAD SOURCE. `component` is gone; see SMART_SEARCH_DEFAULT_SOURCES.
     *
     * FAIL-PARTIAL, NOT FAIL-SILENT. This method used to wrap every source in ONE try
     * whose catch only logged, so a throw while reading contexts returned `[]` — an empty
     * result set is indistinguishable from "nothing matched". Each source is now fetched
     * inside its own try, concurrently; a source that throws is named in `degradedSources`
     * and the others still answer.
     */
    async smartSearchDetailed(
        projectId: string,
        query: string,
        includeTypes: readonly string[] = SMART_SEARCH_DEFAULT_SOURCES,
        limit: number = 10
    ): Promise<SmartSearchOutcome> {
        logger.info(`🔍 Smart search for: "${query}" in project ${projectId}`);
        logger.info(`📋 Include types: [${includeTypes.join(', ')}]`);
        logger.info(`🎯 Limit: ${limit}`);

        // OVER-FETCH: ask each source for more than the caller wants, so the global sort
        // has something to choose between. Never below `limit` itself.
        const overfetch = Math.max(limit, limit * SEARCH_MERGE_OVERFETCH_FACTOR);
        const nowMs = Date.now();

        // AN UNKNOWN SOURCE KEY IS AN ERROR, NOT AN EMPTY RESULT.
        //
        // This filter used to be the whole story, and a filter cannot report a miss: a key
        // matching no adapter simply contributed no candidates, so `includeTypes:['tsak']`
        // (or ['task'], before this build) returned a clean `results: []` with `ok: true`.
        // The caller cannot tell that from "nothing matched", which is the third-state
        // failure — an instrument that answers "no" when it means "I could not run".
        //
        // THE CHOKE POINT IS HERE, not only in the zod schema. The schema gates the MCP tool
        // surface, but smartSearchDetailed is also called directly (routes, tests, future
        // internal callers), and every one of them passes through this line. Guarding only
        // the validator would leave the silent path open to everything that is not the tool.
        const adapters = this.sourceAdapters();
        const known = new Set(adapters.map(a => a.key));
        const unknown = includeTypes.filter(t => !known.has(t));
        if (unknown.length > 0) {
            throw new Error(
                `smart_search: unknown source(s) [${unknown.join(', ')}]. ` +
                `Valid sources: [${[...known].sort().join(', ')}]. ` +
                `Refusing to return an empty result set for a source that does not exist — ` +
                `that is indistinguishable from "nothing matched".`
            );
        }
        const enabled = adapters.filter(a => includeTypes.includes(a.key));
        logger.info(`📊 Sources: [${enabled.map(a => a.key).join(', ')}] over-fetch ${overfetch}/source`);

        // PER-SOURCE try/catch, CONCURRENTLY. One source failing must not zero the others.
        const fetched = await Promise.all(enabled.map(async adapter => {
            try {
                return { key: adapter.key, candidates: await adapter.fetch(projectId, query, overfetch, nowMs), ok: true };
            } catch (error) {
                logger.error(`❌ smart_search source '${adapter.key}' failed`, error as Error);
                return { key: adapter.key, candidates: [] as MergeCandidate[], ok: false };
            }
        }));

        const degradedSources = fetched.filter(f => !f.ok).map(f => f.key);
        const pool = fetched.flatMap(f => f.candidates);

        logger.info(`📊 Pooled ${pool.length} candidates; degraded: [${degradedSources.join(', ') || 'none'}]`);

        // ═══ THE LEXICAL HALF (P2b) ═══
        // Awaited AFTER the semantic sources rather than alongside them only because the
        // semantic fetch above is already a Promise.all; the lexical query and the
        // absent-term probe are two round trips on an idle pool and run concurrently with
        // each other. The whole block is inside the flag: with it off, everything below
        // resolves to "no lexical layer" and the merge is byte-for-byte the pre-P2b one.
        let lexical: LexicalSearchResult | null = null;
        let empty: EmptyStateVerdict | null = null;
        if (LEXICAL_SEARCH_CONFIG.enabled) {
            // FAIL-PARTIAL, exactly as the semantic sources do. A lexical failure names
            // itself in degradedSources and the semantic answer still ships; it must never
            // zero the result set, and it must never be silent either.
            const [lx, ab] = await Promise.all([
                (async () => {
                    try { return await runLexicalSearch(projectId, query, overfetch * SEARCH_MERGE_OVERFETCH_FACTOR); }
                    catch (e) { logger.error('❌ smart_search lexical channel failed', e as Error); degradedSources.push('lexical'); return null; }
                })(),
                (async () => {
                    try { return await findAbsentTerms(query, projectId); }
                    catch (e) { logger.error('❌ smart_search absent-term probe failed', e as Error); degradedSources.push('absent-terms'); return null; }
                })(),
            ]);
            lexical = lx;
            if (ab) {
                // Near-miss vocabulary = the words of the records the search retrieved, from
                // BOTH channels: a typo shares its other terms with the record it misspells, so
                // that record is in the lexical rows even when the semantic pool is empty.
                const rows = lx ? [...lx.identRanked, ...lx.proseRanked] : [];
                const vocab = vocabularyOf([
                    ...pool.map(c => `${c.result.title ?? ''} ${c.result.summary ?? ''}`),
                    ...rows.map(r => `${r.title} ${r.summary}`),
                ]);
                empty = decideEmptyState(ab, vocab);
            }
        }

        // RECONCILE THE ABSENCE CLAIM WITH WHAT THE SEARCH RESOLVED. A record's own id is not
        // in its text, so a bare-id lookup for a record nobody has mentioned reads as "absent"
        // to a probe that only reads text. See reconcileWithResolvedRecords for the measured
        // failure. The inputs are rows that matched by their OWN id/tag, never every row.
        if (empty) {
            const idHits = pool.filter(c => c.idTagHit);
            const resolvedTags = idHits.flatMap(c => {
                const t = (c.result.metadata as Record<string, unknown>)?.tags;
                return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
            });
            empty = reconcileWithResolvedRecords(empty, idHits.map(c => c.result.id), resolvedTags);
        }

        // ═══ BUILD 4 — THE EMPTY STATE ═══
        // A veto SHORT-CIRCUITS: when the corpus has no record of a word the caller typed and
        // that word is not ordinary English, the honest answer is nothing, and it is returned
        // with the WORD that produced it so an empty result can never be mistaken for a broken
        // one. Note this deliberately outranks whatever the channels found — by construction a
        // vetoing term occurs in zero live records of this project, so any row here matched
        // something the caller did not ask about.
        if (empty?.veto) {
            logger.info(`🚫 Smart search EMPTY — no record of [${empty.vetoedBy.join(', ')}]`);
            return {
                results: [], degradedSources,
                absentTerms: empty.absentTerms,
                emptyReason: { kind: 'absent_terms', vetoedBy: empty.vetoedBy },
                lexicalSkipped: lexical?.skipped ?? null,
            };
        }

        const merged = lexical
            ? this.fuseWithLexical(pool, lexical, limit)
            : mergeCandidates(pool, limit);
        logger.info(`✅ Smart search returning ${merged.length} results`);
        merged.forEach((r, i) => logger.info(`   ${i + 1}. [${r.type}] score=${r.relevanceScore.toFixed(4)} ${r.title.substring(0, DEBUG_LOG_TITLE_CHARS)}`)); // headline-clip-exempt: a debug LOG LINE width, not a record headline — this clips a title that recordHeadlineConfig has ALREADY derived, so routing it through the same budget would be a no-op at best and would widen a log line at worst.

        // THE THIRD EMPTY STATE. Every source threw and none of them returned rows: that is a
        // FAILURE, and reporting it as "nothing matched" is the third-state bug this repo
        // keeps paying for — an instrument answering "no" when it means "I could not run".
        const allDegraded = enabled.length > 0 && degradedSources.length >= enabled.length;
        const emptyReason = merged.length > 0
            ? null
            : { kind: (allDegraded ? 'all_degraded' : 'no_match') as 'all_degraded' | 'no_match', vetoedBy: [] as readonly string[] };

        return {
            results: merged, degradedSources,
            absentTerms: empty?.absentTerms ?? null,
            emptyReason,
            lexicalSkipped: lexical?.skipped ?? null,
        };
    }

    /**
     * ═══ BUILD 2 — TWO RANKED LISTS INTO ONE ORDER ═══
     *
     * THE INPUTS ARE RANKS, NOT SCORES (see services/rankFusion.ts for why). The semantic
     * pool is ranked by the EXISTING total order — compareCandidates, i.e. the four-signal
     * blend then created_at then id — so this change does not re-rank the semantic channel;
     * it reads the order the product already produced. The lexical side arrives as two
     * separately-ranked lists, `lexical-ident` and `lexical-prose`.
     *
     * HOW AN IDENTIFIER HIT IS KEPT UNDILUTED BY PROSE RANKING — the thing BUILD 1 asks to
     * be stated. Two mechanisms, both structural:
     *   1. The identifier list is ranked by IDENTIFIER EVIDENCE ONLY — how many of the
     *      caller's literals the record contains — never by ts_rank of its prose. A record
     *      that is a poor prose match but contains the literal whole still takes rank 1.
     *   2. IDENTIFIER PRECEDENCE (config, default on): records with ≥1 identifier hit form a
     *      strict TIER above the rest. It is lexicographic, not a weight — no number trades
     *      one against the other — and it is the same position the product already holds with
     *      SEARCH_ID_MATCH_SCORE_BOOST, which forces an exact id/tag hit to #1 rather than
     *      letting it compete on cosine. An exact match on a rare literal the caller typed is
     *      a LOOKUP, not a similarity estimate.
     * MEASURED with the tier off, everything else held: the exact-token arm falls from 15/17
     * to 10/17 hit@1, losing five questions to semantic-rank-1 ties broken on date. Full
     * table in reports/artifacts/d8c10b18-p2b-hybrid/RESULTS-P2b.md.
     *
     * THE FINAL TIE-BREAK IS THE EXISTING ONE. Ties on fused score fall through to
     * compareCandidates — score, then created_at, then id — because Postgres leaves the order
     * of tied rows undefined and RRF produces exact ties constantly (every id returned at the
     * same rank by the same channels has the same fused score). Without the id term the same
     * query returns a different top-k on different runs.
     */
    private fuseWithLexical(pool: MergeCandidate[], lexical: LexicalSearchResult, limit: number): SmartSearchResult[] {
        const k = HYBRID_SEARCH_CONFIG.rrfK;

        // The semantic channel's ranking IS the pre-P2b merge order.
        const semanticSorted = [...pool].sort(compareCandidates);
        const byId = new Map<string, MergeCandidate>();
        const semanticIds: string[] = [];
        for (const c of semanticSorted) {
            if (byId.has(c.result.id)) continue;
            byId.set(c.result.id, c);
            semanticIds.push(c.result.id);
        }

        // Lexical rows become candidates too — but only for ids the semantic pool did not
        // already carry, so a record found by both keeps its real score and its real source
        // label rather than being replaced by a lexical stub.
        const identHitsById = new Map<string, number>();
        const addLexical = (rows: readonly LexicalRow[]): string[] => rows.map(r => {
            identHitsById.set(r.id, Math.max(identHitsById.get(r.id) ?? 0, r.identHits));
            if (!byId.has(r.id)) byId.set(r.id, lexicalRowToCandidate(r));
            return r.id;
        });
        const identIds = addLexical(lexical.identRanked);
        const proseIds = addLexical(lexical.proseRanked);

        const channels: RankedChannel[] = [
            { channel: 'semantic', ranked: semanticIds },
            { channel: 'lexical-ident', ranked: identIds },
            { channel: 'lexical-prose', ranked: proseIds },
        ];
        const fused = fuseByRank(channels, k);
        const norm = maxFusedScore(k);

        const tiered = [...fused.values()].map(e => {
            const cand = byId.get(e.id)!;
            const identHits = identHitsById.get(e.id) ?? 0;
            // ═══ THE TIER LADDER ═══ Two kinds of exact match, and they are NOT equal:
            //   2  THIS IS THE RECORD YOU NAMED — the row's own id or tag matched the query.
            //   1  THIS RECORD MENTIONS WHAT YOU NAMED — its text contains the literal.
            //   0  everything else, ordered by fused rank.
            // Tier 2 is not new behaviour: it is the pre-P2b guarantee that an exact id/tag
            // hit is result #1 (SEARCH_ID_MATCH_SCORE_BOOST), preserved through a fusion that
            // discards the score that used to carry it. It is NOT gated on
            // identifierPrecedence — that flag is the ablation for the identifier CHANNEL, and
            // turning the channel off must not also take away a lookup that predates it.
            const tier = cand.idTagHit ? 2
                : (HYBRID_SEARCH_CONFIG.identifierPrecedence && identHits > 0) ? 1
                : 0;
            return { e, cand, tier, identHits };
        });

        tiered.sort((a, b) =>
            (b.tier - a.tier) ||
            (b.e.fused - a.e.fused) ||
            compareCandidates(a.cand, b.cand));

        return tiered.slice(0, limit).map(({ e, cand, identHits }) => ({
            ...cand.result,
            // DISPLAY-CONSISTENCY: the number shown IS the sort key. The order
            // is the fused rank, so the reported relevance must be the fused score — rescaled
            // by the CONSTANT maxFusedScore into [0,1], which is monotone and therefore cannot
            // change the order it describes.
            relevanceScore: e.fused / norm,
            metadata: {
                ...cand.result.metadata,
                // WHICH CHANNELS FOUND THIS ROW, and at what rank. This is the diagnostic that
                // makes a fusion regression READABLE instead of a number that moved: a hit lost
                // to the semantic channel and a hit lost to the lexical one look identical in
                // a scorecard and need opposite fixes.
                channels: e.ranks,
                identifierHits: identHits,
                // THE SEMANTIC SCORE, CARRIED THROUGH — not for ranking, for the HONESTY
                // FLOOR. buildHonestyHeader's threshold was calibrated
                // against the four-signal blend; `relevanceScore` above is now a rescaled
                // fused RANK, a different quantity in the same [0,1] clothes, and feeding
                // one to a threshold calibrated on the other would fire the "weak match"
                // warning on strong results for purely arithmetic reasons. Undefined for a
                // row no semantic source returned — which is not a weak match, it is a row
                // that got in on hard lexical evidence.
                semanticScore: e.ranks.semantic !== undefined ? cand.score : undefined,
            },
        }));
    }

    /** Back-compatible shape: the merged rows alone. */
    async smartSearch(
        projectId: string,
        query: string,
        includeTypes: readonly string[] = SMART_SEARCH_DEFAULT_SOURCES,
        limit: number = 10
    ): Promise<SmartSearchResult[]> {
        return (await this.smartSearchDetailed(projectId, query, includeTypes, limit)).results;
    }

    /**
     * The source adapters. Each one's ONLY job is to turn its own rows into candidates
     * carrying the SHARED unified score — so adding a source is a matter of stating its
     * four signals, and no source can invent its own scale.
     */
    private sourceAdapters(): SourceAdapter[] {
        return [
            {
                key: 'context',
                fetch: async (projectId, query, overfetch) => {
                    const rows = await contextHandler.searchContext({
                        projectId,
                        query,
                        limit: overfetch,
                        // PIN the balanced profile: a merged list may not contain rows scored
                        // under two different blends. See SEARCH_MERGE_APPLY_RECENCY_PROFILE.
                        rankProfile: SEARCH_MERGE_APPLY_RECENCY_PROFILE ? 'auto' : 'balanced',
                    });
                    return rows.map(context => {
                        // RANK ON THE SORT KEY. `combined_score` IS the expression the SQL
                        // ordered these rows by, and it is already the unified blend (plus
                        // the id/tag boost, which must survive so a bare-id query still
                        // returns its exact record first). `relevance` is that same number
                        // rounded for display and clamped to [0,1], so it is the correct
                        // fallback on the non-hierarchical branch where `similarity` IS the
                        // sort key. What is NOT used, deliberately, is the raw `similarity`
                        // field on the hierarchical branch: it carries a JS substring boost
                        // of up to +40 that never touched the SQL ordering, so ranking on it
                        // reordered rows against the order the database chose.
                        const sortKey = context.combined_score !== undefined && context.combined_score !== null
                            ? context.combined_score
                            : (context.relevance ?? 0) / 100;
                        return {
                            sourceKey: 'context',
                            score: sortKey * (SEARCH_SOURCE_WEIGHTS.context ?? 1.0),
                            // THE EXACT-LOOKUP FACT, read the way this file already reads it
                            // for decisions two adapters down: every un-boosted combined_score
                            // is in [0,1] by construction, and the id/tag boost is added on top
                            // (contexts.ts, `withIdBoost`), so a sort key above 1 is a boosted
                            // row. If SEARCH_ID_MATCH_SCORE_BOOST is configured BELOW 1 this
                            // under-reports, which degrades to P2b-without-the-fix rather than
                            // to something new — the safe direction.
                            idTagHit: sortKey > 1,
                            createdAt: context.createdAt ?? null,
                            result: {
                                type: 'context' as const,
                                id: context.id,
                                // ONE headline rule for every surface — config/recordHeadlineConfig.ts.
                                title:
                                    deriveTypedRecordHeadline(context.contextType, context.content) ?? '',
                                summary: context.content,
                                relevanceScore: sortKey * (SEARCH_SOURCE_WEIGHTS.context ?? 1.0),
                                metadata: {
                                    tags: context.tags,
                                    type: context.contextType,
                                    createdAt: context.createdAt,
                                },
                                source: 'semantic_search',
                            },
                        };
                    });
                },
            },
            {
                key: 'decision',
                fetch: async (projectId, query, overfetch, nowMs) => {
                    const rows = await decisionsHandler.searchDecisions({ projectId, query, limit: overfetch });
                    return rows.map(decision => {
                        // decision_search reports `similarity` as its sort key on a 0-100
                        // scale. It is a pure cosine now that the trigram GREATEST is gone
                        // (see decisions.ts), EXCEPT that an exact id/tag hit adds a flat
                        // +1.0 on the 0-1 scale to force that row to #1. Split the two apart
                        // so the cosine enters the blend and the boost passes through
                        // additively — exactly how contexts carry the same boost.
                        const raw = (decision.similarity ?? 0) / 100;
                        const cosine = Math.min(1, raw);
                        const idBoost = Math.max(0, raw - 1);
                        const blended = unifiedScore({
                            cosine,
                            createdAt: decision.decisionDate,
                            importance: DECISION_IMPACT_IMPORTANCE[decision.impactLevel] ?? DECISION_IMPACT_IMPORTANCE_DEFAULT,
                            typeWeight: DECISION_TYPE_WEIGHT,
                        }, RANK_WEIGHTS.balanced, nowMs);
                        const score = (blended + idBoost) * (SEARCH_SOURCE_WEIGHTS.decision ?? 1.0);
                        return {
                            sourceKey: 'decision',
                            score,
                            idTagHit: idBoost > 0,
                            createdAt: decision.decisionDate ?? null,
                            result: {
                                type: 'decision' as const,
                                id: decision.id,
                                title: `DECISION: ${decision.title}`,
                                summary: decision.description,
                                relevanceScore: score,
                                metadata: {
                                    decisionType: decision.decisionType,
                                    impactLevel: decision.impactLevel,
                                    tags: decision.tags,
                                },
                                source: 'decision_search',
                            },
                        };
                    });
                },
            },
            {
                key: 'task',
                fetch: async (projectId, query, overfetch, nowMs) => {
                    const rows = await tasksHandler.searchTasks({ projectId, query, limit: overfetch });
                    return rows.map(task => {
                        // THE SAME QUANTITY AS EVERY OTHER SOURCE. The task source computes no
                        // score of its own: it states its four signals and hands them to the
                        // SHARED unifiedScore under RANK_WEIGHTS.balanced with the SHARED
                        // nowMs. A private scale here — even a defensible-looking one — is
                        // defect D1, which is what made a constant 0.6 outrank every real
                        // context. `nowMs` is passed rather than defaulted so every row in one
                        // merge decays from ONE instant; letting each call read its own clock
                        // makes the recency term depend on evaluation order.
                        // THE RAW SORT KEY, NOT THE DISPLAY NUMBER — the same rule the
                        // context adapter above states. `task.similarity` is the identical
                        // value rounded to one decimal of a percentage for humans; ranking
                        // on it quantises the merge's sort key to 0.001 and turns near-ties
                        // into exact ties resolved by date instead of by relevance.
                        const cosine = task.cosineScore ?? 0;
                        // The boost is applied HERE, from the one constant that owns it, to
                        // the FACT the source reported. It is ADDITIVE and sits outside the
                        // blend, so it lifts an exact hit to #1 without distorting the four
                        // weighted signals — exactly how contexts and decisions carry it.
                        const idBoost = task.idTagHit ? SEARCH_ID_MATCH_SCORE_BOOST : 0;
                        const blended = unifiedScore({
                            cosine,
                            // The task's REAL created_at — this is what feeds the recency
                            // term, so a wrong or absent date silently zeroes that signal
                            // rather than erroring.
                            createdAt: task.createdAt,
                            // STATUS enters the score HERE and only here:
                            // the base importance scaled by the status→weight map, whose
                            // defaults are all 1.0. See searchMergeConfig for the bound.
                            importance: taskImportance(task.status),
                            typeWeight: TASK_TYPE_WEIGHT,
                        }, RANK_WEIGHTS.balanced, nowMs);
                        const score = (blended + idBoost) * (SEARCH_SOURCE_WEIGHTS.task ?? 1.0);
                        return {
                            sourceKey: 'task',
                            score,
                            idTagHit: task.idTagHit === true,
                            createdAt: task.createdAt ?? null,
                            result: {
                                type: 'task' as const,
                                id: task.id,
                                title: `TASK: ${task.title}`,
                                summary: task.description ?? task.title,
                                relevanceScore: score,
                                metadata: {
                                    taskType: task.type,
                                    // Surfaced because a reader deciding whether a task is
                                    // still live needs them. Status also feeds the importance
                                    // term above; priority reaches the score only through the
                                    // embed text.
                                    status: task.status,
                                    priority: task.priority,
                                    tags: task.tags,
                                },
                                source: 'task_search',
                            },
                        };
                    });
                },
            },
        ];
    }

    async getRecommendations(
        projectId: string,
        context: string,
        type: 'naming' | 'implementation' | 'architecture' | 'testing' = 'implementation'
    ): Promise<Recommendation[]> {
        logger.info(`💡 Generating ${type} recommendations for project ${projectId}`);
        
        const recommendations: Recommendation[] = [];

        try {
            // Naming recommendations removed - replaced by dependency tracking system
            // type === 'naming' no longer supported

            if (type === 'implementation' || type === 'architecture') {
                // Find similar implementations using semantic search
                const similarContexts = await contextHandler.searchContext({
                    projectId,
                    query: context, 
                    limit: 3
                });
                for (const ctx of similarContexts) {
                    if (ctx.contextType === 'code' && ctx.similarity && ctx.similarity > 0.7) {
                        recommendations.push({
                            type: 'pattern',
                            title: `Consider similar implementation pattern`,
                            description: `Found similar code: ${deriveRecordHeadline(ctx.content) ?? ''}`,
                            confidence: ctx.similarity,
                            actionable: true,
                            references: [ctx.id],
                            metadata: {
                                contextType: ctx.contextType,
                                tags: ctx.tags
                            }
                        });
                    }
                }

                // Architecture recommendations from decisions
                const archDecisions = await decisionsHandler.searchDecisions({
                    projectId,
                    decisionType: 'architecture',
                    limit: 2
                });

                for (const decision of archDecisions) {
                    recommendations.push({
                        type: 'decision',
                        title: `Follow architecture decision: ${decision.title}`,
                        description: decision.rationale,
                        confidence: 0.9,
                        actionable: true,
                        references: [decision.id],
                        metadata: {
                            impactLevel: decision.impactLevel,
                            components: decision.affectedComponents
                        }
                    });
                }
            }

            if (type === 'testing') {
                // Find components that might need testing
                const client = await this.pool.connect();
                try {
                    const untested = await client.query(`
                        SELECT name, component_type, complexity_score, file_path
                        FROM code_components 
                        WHERE project_id = $1 AND is_exported = true 
                        AND complexity_score > 2
                        -- 'id DESC' makes this LIMIT a TOTAL order:
                        -- complexity_score is a small integer, so a project routinely has
                        -- more than three components sharing the top value and WHICH three
                        -- you are told to test was decided by physical row order.
                        ORDER BY complexity_score DESC, id DESC
                        LIMIT 3
                    `, [projectId]);

                    for (const component of untested.rows) {
                        recommendations.push({
                            type: 'task',
                            title: `Add tests for complex component: ${component.name}`,
                            description: `${component.component_type} has complexity score ${component.complexity_score} and should have comprehensive tests`,
                            confidence: Math.min(component.complexity_score / 5, 1.0),
                            actionable: true,
                            references: [],
                            metadata: {
                                componentType: component.component_type,
                                filePath: component.file_path,
                                complexity: component.complexity_score
                            }
                        });
                    }
                } finally {
                    client.release();
                }
            }
        } catch (error) {
            logger.error('Error generating recommendations', error as Error);
        }

        recommendations.sort((a, b) => b.confidence - a.confidence);
        logger.info(`✅ Generated ${recommendations.length} recommendations`);
        return recommendations;
    }

    /**
     * SOFT-DELETE: `includeArchived` defaults to FALSE, so all three entity
     * breakdowns below count only LIVE rows and therefore reconcile with context_search /
     * decision_search / task_list. Before this, every one of them counted archived rows —
     * the same defect measured on prod for decision_stats (556 vs 127). Same param name and
     * meaning as the three search tools; one concept, one spelling.
     *
     * It reaches `teamEfficiency` too, on purpose: a completion rate whose denominator
     * includes tasks that were archived out of the board is not this project's completion
     * rate. Class-level fuse: src/tests/statsSearchCountReconcile.contract.test.ts.
     */
    async getProjectInsights(projectId: string, includeArchived: boolean = false): Promise<any> {
        logger.info(`🔍 Analyzing project insights for ${projectId} (includeArchived: ${includeArchived})`);

        const client = await this.pool.connect();
        try {
            // Get high-level project metrics + the GRAPH. `coverage` reads
            // the typed-edge graph; the three *Stats reads remain because they are the
            // project's descriptive totals — they are REPORTED, and (unlike before) nothing
            // is ever RECOMMENDED because one of them is small.
            const [codeStats, contextStats, decisionStats, taskStats, coverage] = await Promise.all([
                codeAnalysisHandler.getProjectAnalysisStats(projectId),
                this.getContextInsights(projectId, includeArchived),
                this.getDecisionInsights(projectId, includeArchived),
                this.getTaskInsights(projectId, includeArchived),
                buildProjectCoverage(projectId)
            ]);

            // Generate insights
            const insights = {
                codeHealth: this.assessCodeHealth(codeStats),
                // GRAPH-DERIVED COVERAGE replaces identifyKnowledgeGaps()/identifyDecisionGaps()
                // (Amp-orb eval report lines 558-581). Those two functions were
                // raw count thresholds with ZERO edge reads — `decisionStats.total < 5` →
                // "Low decision count - consider documenting more technical choices", which is
                // VERBATIM the advice the evaluator received on a project that had exactly the
                // decisions it needed and every task complete. They are DELETED, not demoted:
                // leaving a volume heuristic beside a coverage signal would let the graph's
                // honest answer be contradicted by the one we just proved wrong.
                //
                // `decisionGaps` was ALSO a dead path — computed here, returned on this object,
                // and read by NEITHER channel of the sole caller (routes/search.routes.ts
                // renders only knowledgeGaps and puts only knowledgeGaps in structuredContent).
                // The second instance of the b7306192 class noted below; both are gone now.
                coverage,
                teamEfficiency: this.assessTeamEfficiency(taskStats)
                // NOTE: a `recommendations: await this.getRecommendations(...)`
                // field used to be computed here and then DISCARDED — the sole caller
                // (routes/search.routes.ts:handleProjectInsights) never read it in EITHER
                // channel: it is absent from the text body (which instead tells the user to
                // "Get specific recommendations with: get_recommendations") and absent from
                // structuredContent. Every project_insights call therefore paid for a
                // multi-query recommendation engine for nothing. The get_recommendations
                // TOOL still calls the same public method directly and is unaffected.
            };

            return {
                projectId,
                generatedAt: new Date(),
                codeStats,
                contextStats,
                decisionStats,
                taskStats,
                insights
            };
        } finally {
            client.release();
        }
    }

    private async getContextInsights(projectId: string, includeArchived: boolean = false): Promise<any> {
        const client = await this.pool.connect();
        try {
            // SOFT-DELETE — see getProjectInsights. Built once per method
            // because each has exactly one query; the DEFAULT is the safe one (exclude), so
            // a caller that forgets the argument gets the reconciling behaviour, not the bug.
            const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
            const result = await client.query(`
                SELECT
                    context_type as type,
                    COUNT(*) as count,
                    AVG(relevance_score) as avg_relevance
                FROM contexts
                WHERE project_id = $1${archivedFilter}
                GROUP BY context_type
            `, [projectId]);
            
            return result.rows.reduce((acc, row) => {
                acc[row.type] = {
                    count: parseInt(row.count),
                    avgRelevance: parseFloat(row.avg_relevance)
                };
                return acc;
            }, {});
        } finally {
            client.release();
        }
    }

    private async getDecisionInsights(projectId: string, includeArchived: boolean = false): Promise<any> {
        // SOFT-DELETE — see getProjectInsights.
        const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
        const client = await this.pool.connect();
        try {
            const result = await client.query(`
                SELECT
                    decision_type,
                    impact_level,
                    COUNT(*) as count
                FROM technical_decisions
                WHERE project_id = $1${archivedFilter}
                GROUP BY decision_type, impact_level
            `, [projectId]);
            
            return {
                total: result.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
                byType: result.rows.reduce((acc, row) => {
                    if (!acc[row.decision_type]) acc[row.decision_type] = {};
                    acc[row.decision_type][row.impact_level] = parseInt(row.count);
                    return acc;
                }, {})
            };
        } finally {
            client.release();
        }
    }

    private async getTaskInsights(projectId: string, includeArchived: boolean = false): Promise<any> {
        // SOFT-DELETE — see getProjectInsights. NOTE this is a filter, NOT an
        // existence check: it narrows WHICH rows are counted and cannot turn an unreadable
        // table into a plausible zero. The fail-loud rule documented below is unchanged —
        // a query error still propagates.
        const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
        const client = await this.pool.connect();
        try {
            // ─────────────────────────────────────────────────────────────────────
            // NO TABLE-EXISTENCE CHECK HERE — ON PURPOSE.
            //
            // This query used to read `agent_tasks`, a table that no longer exists.
            //
            // PROVENANCE — stated only as far as it is VERIFIED, because this comment's
            // whole job is to stop the next person re-adding the camouflage, and a
            // citation that doesn't check out destroys its authority exactly when it is
            // needed. What is verified:
            //   • `agent_tasks` was created by 005_create_agent_coordination.sql:31 and
            //     altered by 007/008.
            //   • NO migration in database/migrations/ renames or drops it — there is no
            //     such statement anywhere in the tree. In particular
            //     016_remove_agent_system.sql (which its NAME and header suggest did the
            //     job, and which an earlier version of this comment cited) contains ZERO
            //     occurrences of `agent_tasks`: it establishes `tasks` by creating it
            //     fresh / migrating from `tasks_backup` + `agents_backup`.
            //   • The consolidated 000_baseline_schema.sql declares `public.tasks` (5101)
            //     and no `agent_tasks`.
            //   • VERIFIED END STATE (live prod, read-only): `tasks` exists,
            //     `agent_tasks` does not.
            // So: the agent system's removal retired `agent_tasks` without an explicit
            // rename/drop migration, and the exact commit that dropped it is NOT
            // established. The END STATE is certain, and it is the end state that matters
            // here — this read must target `tasks`.
            //
            // Then commit c688805 wrapped this query in an information_schema existence check
            // that returned {total: 0} when the table was missing — converting a LOUD
            // `relation "agent_tasks" does not exist` into a PLAUSIBLE SILENT ZERO.
            //
            // That guard WAS the bug's camouflage. It is the only reason a flagship
            // 715-task project reported "0 tasks / 0% completion" for ~10 months across
            // 53 of 99 projects without anyone noticing.
            //
            // The rule this encodes: if the underlying data cannot be read, this MUST
            // FAIL LOUD. A query error propagates to the caller as an error — never as
            // a zero a human will believe. DO NOT re-add an existence check, a
            // try/catch returning defaults, or a `|| 0` fallback here.
            // Guarded by src/tests/projectInsights.contract.test.ts (fail-loud probe).
            // ─────────────────────────────────────────────────────────────────────
            const result = await client.query(`
                SELECT
                    status,
                    priority,
                    COUNT(*) as count
                FROM tasks
                WHERE project_id = $1${archivedFilter}
                GROUP BY status, priority
            `, [projectId]);
            
            return {
                total: result.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
                byStatus: result.rows.reduce((acc, row) => {
                    if (!acc[row.status]) acc[row.status] = {};
                    acc[row.status][row.priority] = parseInt(row.count);
                    return acc;
                }, {})
            };
        } finally {
            client.release();
        }
    }

    /**
     * Assess code health from the project's code-component stats.
     *
     * THE BUG THIS FIXES — "absent rendered as perfect":
     *   AVG(complexity_score) over ZERO rows returns SQL NULL. Upstream, getProjectAnalysisStats
     *   coerces that with `|| 0`, so a project with NO analyzed code arrived here as
     *   avgComplexity 0 / maxComplexity 0. The old scoring then computed 100 - 0 - 0 = 100
     *   and the old banding read 0 < 3 as 'healthy'. Result: a project with nothing behind it
     *   reported "🟢 HEALTHY 100/100" while simultaneously listing "No code analyzed yet".
     *   98 of 99 projects returned that fabricated green. A wrong number is visible; a
     *   fabricated green is TRUSTED — which makes it the worse of the two symptoms.
     *
     * THE RULE: absent data reports `no_data` with a NULL score. It NEVER reports a number.
     * `score: null` is the honest shape — not 0, which would read as "terrible health" and be
     * just as much a fabrication as 100. The display layer already had a `no_data` branch
     * (routes/search.routes.ts) that this producer never emitted; now it does.
     *
     * FAIL LOUD: a missing/malformed codeStats input throws rather than defaulting. Absent
     * inputs must surface as an error, never as a score a human will believe. Do NOT
     * re-introduce `|| 0` coercion on the discriminator below.
     */
    private assessCodeHealth(codeStats: any): any {
        // ── FAIL-LOUD GUARD ──────────────────────────────────────────────────────
        // If we cannot READ the component count, we cannot honestly say anything about
        // health. Throw. Never fall back to a default that manufactures a score.
        if (codeStats === null || typeof codeStats !== 'object') {
            throw new Error(
                `assessCodeHealth: codeStats is missing or not an object (got ${codeStats === null ? 'null' : typeof codeStats}) — ` +
                `refusing to fabricate a health score from unreadable data`
            );
        }
        if (typeof codeStats.totalComponents !== 'number' || !Number.isFinite(codeStats.totalComponents)) {
            throw new Error(
                `assessCodeHealth: codeStats.totalComponents is not a finite number (got ${JSON.stringify(codeStats.totalComponents)}) — ` +
                `refusing to fabricate a health score from unreadable data`
            );
        }

        const totalComponents = codeStats.totalComponents;

        // ── NO DATA: nothing analyzed → say so. Never score it. ──────────────────
        if (totalComponents === 0) {
            return {
                score: null,
                level: HEALTH_LEVEL_NO_DATA,
                issues: ['No code analyzed yet']
            };
        }

        // ── SCORED: behaviour below is byte-identical to pre-fix, thresholds now named. ──
        const avgComplexity = codeStats.averageComplexity || 0;
        const maxComplexity = codeStats.maxComplexity || 0;
        const maxIsComplex = maxComplexity > HEALTH_MAX_COMPLEXITY_THRESHOLD;

        return {
            score: Math.max(
                HEALTH_SCORE_FLOOR,
                Math.min(
                    HEALTH_SCORE_CEILING,
                    HEALTH_SCORE_CEILING
                        - (avgComplexity * HEALTH_AVG_COMPLEXITY_WEIGHT)
                        - (maxIsComplex ? HEALTH_MAX_COMPLEXITY_PENALTY : 0)
                )
            ),
            level: avgComplexity < HEALTH_LEVEL_HEALTHY_MAX
                ? 'healthy'
                : avgComplexity < HEALTH_LEVEL_MODERATE_MAX
                    ? 'moderate'
                    : 'needs_attention',
            issues: [
                ...(avgComplexity > HEALTH_HIGH_COMPLEXITY_ISSUE_THRESHOLD ? ['High average complexity'] : []),
                ...(maxIsComplex ? ['Very complex components exist'] : [])
            ]
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DELETED HERE: identifyKnowledgeGaps() + identifyDecisionGaps().
    //
    // They were raw count thresholds with ZERO edge reads — `contextStats.error.count < 2`,
    // `contextStats.decision.count < 3`, `contextStats.planning.count < 2`,
    // `decisionStats.total < 5`, `!decisionStats.byType.architecture` — and their output is
    // exactly what the Amp-orb evaluator was told on a project that had precisely the
    // decisions it needed, all tasks complete and strong graph evidence. A health signal that
    // rewards VOLUME is a health signal nobody should trust.
    //
    // Their replacement is services/projectCoverage.ts: coverage over the typed-edge graph,
    // consuming part B's current-state projector for the frontier. It is wired in
    // getProjectInsights() above as `insights.coverage`. Guarded by
    // src/tests/projectCoverage.unit.test.ts (a ×1/×3/×17 SCALE-INVARIANCE property: holding
    // the ratios constant while multiplying every population must not change which findings
    // fire — a count-triggered rule cannot pass it) and
    // src/tests/projectInsightsGraphAware.contract.test.ts (the eval's acceptance, on the
    // real tool).
    //
    // DO NOT re-add a rule that fires on a record COUNT. That is the defect, not the fix.
    // ─────────────────────────────────────────────────────────────────────────

    private assessTeamEfficiency(taskStats: any): any {
        if (taskStats.total === 0) {
            return {
                score: 0,
                level: HEALTH_LEVEL_NO_DATA,
                issues: ['No tasks created yet']
            };
        }

        const completed = taskStats.byStatus.completed || {};

        const completedCount = Object.values(completed).reduce((a: any, b: any) => a + b, 0) as number;
        const totalCount = taskStats.total;
        const completionRate = completedCount / totalCount;
        
        return {
            score: Math.round(completionRate * 100),
            level: completionRate > 0.7 ? 'efficient' : completionRate > 0.4 ? 'moderate' : 'needs_improvement',
            completionRate,
            totalTasks: totalCount,
            completedTasks: completedCount
        };
    }
}

// Export singleton instance
export const smartSearchHandler = new SmartSearchHandler();
