/**
 * THE context wire record. See recordSerializer.ts for the class and the mark.
 *
 * Emits the UNION of what context_store, the three context_search branches (by-id, tags-only,
 * semantic), context_get_recent and context_update each hand-enumerated, so every existing
 * key keeps its name and value.
 *
 * THE BODY IS A DIAL (SEARCH P3): list surfaces project `content` through
 * `projectBody()` and at `headline` carry no body at all. Pass the projected body as `body`;
 * when it is not `present` no `content`/`truncated` key is emitted — a caller must be able to
 * tell "this altitude carries no bodies" from "this record has an empty one". Omit `body`
 * entirely to emit the full stored content (the write echoes).
 */
import type { ContextEntry } from '../../handlers/context.js';
import type { ProjectedBody } from '../altitudeProjection.js';
import { recordUrl } from '../../config/commandUrlConfig.js';
import { markSerialized, toIso } from './recordSerializer.js';

export interface SerializeContextOptions {
  /** Projected body; absent → full `content`, present-but-not-`present` → no body keys. */
  body?: ProjectedBody;
  /** Already-projected trust (list `{band,score}` or the by-id full verdict). Emitted as given. */
  trust?: unknown;
  /** Semantic-search ranking numbers, emitted only when supplied. */
  ranking?: { relevance?: number; similarity?: number };
  /** Route-specific additions (write reports). Merged BEFORE marking. */
  extras?: Record<string, unknown>;
}

export function serializeContext(ctx: ContextEntry, opts: SerializeContextOptions = {}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: ctx.id,
    url: recordUrl(ctx.id),
    contextType: ctx.contextType,
    ...(opts.body === undefined
      ? { content: ctx.content }
      : opts.body.present
        ? { content: opts.body.text, truncated: opts.body.clipped }
        : {}),
    tags: ctx.tags ?? [],
    relevanceScore: ctx.relevanceScore,
    projectId: ctx.projectId,
    sessionId: ctx.sessionId ?? null,
    metadata: ctx.metadata ?? {},
    createdAt: toIso(ctx.createdAt),
    ...('archivedAt' in ctx ? { archivedAt: toIso(ctx.archivedAt) } : {}),
    ...(opts.ranking?.relevance !== undefined ? { relevance: opts.ranking.relevance } : {}),
    ...(opts.ranking?.similarity !== undefined ? { similarity: opts.ranking.similarity } : {}),
    ...(opts.trust !== undefined ? { trust: opts.trust } : {}),
    ...(opts.extras ?? {}),
  };
  return markSerialized('context', record);
}
