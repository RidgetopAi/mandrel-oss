/**
 * THE decision wire record. See recordSerializer.ts for the class and the mark.
 *
 * Emits the canonical camelCase record every route now shares, PLUS — where a route shipped
 * them historically — the snake_case aliases decision_search / decision_get have always
 * emitted (`decision_type`, `impact_level`, `project_id`, …). Those two routes were written
 * for a frontend consumer and the aliases are part of their wire contract; they are produced
 * HERE, under `legacyAliases`, so the spelling table exists in exactly one place.
 *
 * ONE GENUINE DIVERGENCE, preserved: `alternatives` is a list of NAMES on decision_search and
 * the full `{name, reasonRejected}` objects on decision_get. The canonical field is
 * `alternativesConsidered` (objects) and is emitted everywhere; `alternativesAs` selects the
 * legacy form of the alias.
 */
import type { TechnicalDecision } from '../../handlers/decisions.js';
import { recordUrl } from '../../config/commandUrlConfig.js';
import { markSerialized, toIso } from './recordSerializer.js';

export interface SerializeDecisionOptions {
  /** Emit the snake_case aliases decision_search/decision_get have always carried. */
  legacyAliases?: boolean;
  /** Form of the legacy `alternatives` alias (see header). Only read with `legacyAliases`. */
  alternativesAs?: 'names' | 'objects';
  /** Already-projected trust, emitted as given. */
  trust?: unknown;
  /** Route-specific additions (write reports). Merged BEFORE marking. */
  extras?: Record<string, unknown>;
}

export function serializeDecision(
  d: TechnicalDecision,
  opts: SerializeDecisionOptions = {},
): Record<string, unknown> {
  const alternatives = d.alternativesConsidered ?? [];
  const record: Record<string, unknown> = {
    id: d.id,
    url: recordUrl(d.id),
    projectId: d.projectId,
    sessionId: d.sessionId ?? null,
    title: d.title,
    description: d.description,
    rationale: d.rationale,
    decisionType: d.decisionType,
    impactLevel: d.impactLevel,
    status: d.status,
    problemStatement: d.problemStatement ?? null,
    successCriteria: d.successCriteria ?? null,
    implementationStatus: d.implementationStatus ?? null,
    outcomeStatus: d.outcomeStatus ?? null,
    outcomeNotes: d.outcomeNotes ?? null,
    lessonsLearned: d.lessonsLearned ?? null,
    supersededBy: d.supersededBy ?? null,
    supersededDate: toIso(d.supersededDate),
    supersededReason: d.supersededReason ?? null,
    decidedBy: d.decidedBy ?? null,
    stakeholders: d.stakeholders ?? [],
    category: d.category ?? null,
    alternativesConsidered: alternatives,
    affectedComponents: d.affectedComponents ?? [],
    tags: d.tags ?? [],
    metadata: d.metadata ?? {},
    decisionDate: toIso(d.decisionDate),
    ...('archivedAt' in d ? { archivedAt: toIso(d.archivedAt) } : {}),
    // THE DECISION INBOX (migration 104).
    answerStatus: d.answerStatus,
    question: d.question ?? null,
    options: d.options ?? [],
    chosen: d.chosen ?? null,
    answeredAt: toIso(d.answeredAt),
    answeredBy: d.answeredBy ?? null,
    answerNote: d.answerNote ?? null,
    deadline: toIso(d.deadline),
    ...(d.similarity !== undefined ? { similarity: d.similarity } : {}),
    ...(opts.trust !== undefined ? { trust: opts.trust } : {}),
    ...(opts.legacyAliases
      ? {
          project_id: d.projectId,
          session_id: d.sessionId ?? null,
          decision_type: d.decisionType,
          impact_level: d.impactLevel,
          affected_components: d.affectedComponents ?? [],
          problem: d.problemStatement || d.description,
          decision: d.description,
          alternatives:
            opts.alternativesAs === 'names'
              ? alternatives.map((alt) => (typeof alt === 'string' ? alt : alt.name))
              : alternatives,
          created_at: toIso(d.decisionDate),
          updated_at: toIso(d.decisionDate),
        }
      : {}),
    ...(opts.extras ?? {}),
  };
  return markSerialized('decision', record);
}
