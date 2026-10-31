/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class TreeWalkerService {
    /**
     * Walk the LIVE resume-anchor thread (whole-thread graph + recall_thread story + trust)
     * Resolves the newest `ref:resume`-tagged context in the active project (X-Project-ID scoped), walks its typed-edge thread ~2 hops over the `links` graph (migration 049), and returns the ThreadGraph the TreeWalker screen renders: spine lineage, nodes (kind + trust), typed edges, and the ordered story. A genuinely-empty thread returns an honest empty graph (never fabricated).
     *
     * @returns any Thread graph retrieved
     * @throws ApiError
     */
    public static getTreewalkerThread(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/treewalker/thread',
        });
    }
    /**
     * The project's handoff TIMELINE (the trunk) — time-ordered, supersession as corroboration only
     * PHASE 2 item a: the trunk tier resolved from DATA — the scoped project's handoff contexts newest-first (full count + bounded entries + the trunk head id). Ordering is created_at ALWAYS; a declared supersedes edge appears only as per-entry corroboration metadata. No recursive supersedes walk exists on this path.
     *
     * @returns any Trunk timeline retrieved
     * @throws ApiError
     */
    public static getTreewalkerTrunk(): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/treewalker/trunk',
        });
    }
    /**
     * The branch list (resume surface) — spines with DECLARED members, newest-active first
     * PHASE 2 item c: branches enumerated from declared `informs` membership edges (the link_provenance view — P1 positional + tag/links-arg provenance), named by their once-on-the-spine `branch:` tag else spine title, with open branch positions marked. TOP-LEVEL DRAWERS ONLY (P2): a spine that is itself a member of another branch (a SECTION) is filtered out BEFORE the cap, not merely flagged, so it can never consume a page slot a genuine drawer needed. Each branch reports sectionCount (how many of its own members are themselves branch spines); the envelope carries the honest `total` DRAWER count (post-filter, pre-cap) and the `cap` applied, so a caller can never mistake a truncated list for the whole set. Each branch carries firstActiveAt and its milestone stations; the envelope carries `sinceDays` (the window applied; default from config, overridable by the query parameter) and `unbranched` ({unbranched, total, windowDays}).
     *
     * @returns any Branch list retrieved
     * @throws ApiError
     */
    public static getTreewalkerBranches({
        sinceDays,
    }: {
        /**
         * Only branches active inside this many days are listed.
         */
        sinceDays?: number,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/treewalker/branches',
            query: {
                'sinceDays': sinceDays,
            },
        });
    }
    /**
     * Walk an EXPLICIT anchor's thread (whole-thread graph + recall_thread story + trust)
     * @returns any Thread graph retrieved
     * @throws ApiError
     */
    public static getTreewalkerThread1({
        anchorId,
    }: {
        anchorId: string,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/treewalker/{anchorId}/thread',
            path: {
                'anchorId': anchorId,
            },
            errors: {
                404: `Anchor not found`,
            },
        });
    }
    /**
     * Why does this record exist, and what did it lead to
     * One record's DECLARED causes (decided_by / learned_from / depends_on / built_by / caused) grouped by edge type, the records each decision cause spawned, the branch it belongs to, its SERIES (possibly_supersedes — guessed, never a cause), the branch members just before it (by time, not an edge) and its declared/guessed edge totals. Project-scoped by X-Project-ID: a record in another project is a 404, never a leak. Deliberately NOT `:anchorId` — that param answers 403 for a foreign record.
     *
     * @returns any Why retrieved
     * @throws ApiError
     */
    public static getTreewalkerRecordWhy({
        id,
    }: {
        id: string,
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/treewalker/record/{id}/why',
            path: {
                'id': id,
            },
            errors: {
                404: `Record not found in the caller's project scope`,
            },
        });
    }
}
