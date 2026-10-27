/**
 * DECISION EMBED-BOUNDED UNIT TEST
 *
 * THE BUG (found while auditing the field-size caps — pre-existing, not introduced):
 *   handlers/decisions.ts builds its embedding text by concatenating title + description +
 *   rationale + problemStatement + successCriteria UNBOUNDED and hands the whole thing to
 *   embeddingService.generateEmbedding. The embedder REJECTS input above
 *   EMBEDDING_MAX_TEXT_LENGTH (8000) — services/embedding/validation.ts `validateInput`
 *   THROWS. Both call sites catch that throw and store the decision WITHOUT an embedding,
 *   so the decision silently drops out of semantic search (trgm fallback only).
 *
 *   This was ALREADY reachable before the cap fix: the old caps summed to ~11,255 chars
 *   (description 5000 + rationale 2000 + problemStatement 2000 + successCriteria 2000 + (reserved-port-ok: char budget in a doc comment, not a port)
 *   title 255) — comfortably past 8000. Deriving the prose caps from their TEXT columns
 * would have made it routine rather than occasional.
 *
 * THE FIX: bound the embed text in the ONE shared builder (buildDecisionEmbeddingText),
 * not at the two call sites — so record, re-embed, and any future call site inherit it.
 * This mirrors the invariant handlers/context.ts always had (embed only the first 1000
 * chars of content). Truncating the EMBED INPUT never truncates the STORED decision.
 *
 * WHAT WOULD MAKE THIS GO RED: remove the boundEmbeddingText() call in
 * buildDecisionEmbeddingText → the long-prose case exceeds the limit → RED.
 * (Mutation-probed.)
 */

import { describe, test, expect } from 'vitest';

import { buildDecisionEmbeddingText } from '../handlers/decisions.js';
import { EMBEDDING_MAX_TEXT_LENGTH, boundEmbeddingText } from '../config/embeddingConfig.js';
import { validateInput } from '../services/embedding/validation.js';

describe('boundEmbeddingText', () => {
  test('leaves text at or under the limit untouched', () => {
    const short = 'a short decision rationale';
    expect(boundEmbeddingText(short)).toBe(short);
    const exact = 'x'.repeat(EMBEDDING_MAX_TEXT_LENGTH);
    expect(boundEmbeddingText(exact)).toHaveLength(EMBEDDING_MAX_TEXT_LENGTH);
  });

  test('truncates text above the limit to exactly the limit', () => {
    expect(boundEmbeddingText('x'.repeat(EMBEDDING_MAX_TEXT_LENGTH + 5_000))).toHaveLength(
      EMBEDDING_MAX_TEXT_LENGTH
    );
  });
});

describe('buildDecisionEmbeddingText — embed-bounded so a long decision never loses its embedding', () => {
  const huge = (n: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 27)).slice(0, n);

  test('a decision whose prose FAR exceeds the embedder limit still yields acceptable text', () => {
    const text = buildDecisionEmbeddingText({
      decisionType: 'architecture',
      title: 'A decision with very long prose',
      description: huge(50_000),
      rationale: huge(50_000),
      problemStatement: huge(50_000),
      successCriteria: huge(50_000),
      tags: ['long', 'prose'],
    });

    // The bound itself.
    expect(text.length).toBeLessThanOrEqual(EMBEDDING_MAX_TEXT_LENGTH);

    // THE REAL ASSERTION: the embedder's own gate ACCEPTS it. Pre-fix this text was
    // ~200k chars and validateInput THREW → the decision was stored with no embedding.
    // This exercises the actual validator the service calls, not a re-implementation.
    expect(() => validateInput(text, EMBEDDING_MAX_TEXT_LENGTH)).not.toThrow();
  });

  test('the reproduction of the PRE-EXISTING bug: unbounded text would be REJECTED by the embedder', () => {
    // Proves the guarded condition is real rather than hypothetical: the same concatenation
    // WITHOUT the bound is exactly what validateInput rejects (→ silent embedding loss).
    const unbounded = ['x'.repeat(5000), 'y'.repeat(2000), 'z'.repeat(2000)].join('\n'); // reserved-port-ok: repeat() length, not a port
    expect(unbounded.length).toBeGreaterThan(EMBEDDING_MAX_TEXT_LENGTH);
    expect(() => validateInput(unbounded, EMBEDDING_MAX_TEXT_LENGTH)).toThrow(/too long/i);
  });

  test('a normal-sized decision is passed through verbatim (no gratuitous truncation)', () => {
    const text = buildDecisionEmbeddingText({
      decisionType: 'database',
      title: 'Adopt pgvector',
      description: 'Store embeddings in Postgres.',
      rationale: 'One datastore, no extra ops surface.',
      tags: ['db'],
    });
    expect(text).toContain('Adopt pgvector');
    expect(text).toContain('One datastore, no extra ops surface.');
    expect(text.length).toBeLessThan(EMBEDDING_MAX_TEXT_LENGTH);
  });
});
