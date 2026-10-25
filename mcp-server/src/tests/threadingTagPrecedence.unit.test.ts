/**
 * TRUST-THREADING-TAG PRECEDENCE — pure unit tests for hasTrustThreadingTag.
 *
 * The context_store route uses hasTrustThreadingTag(result.tags) as the "explicit tag beats
 * the active anchor" precedence signal (ladder: explicit links > explicit task:/decision:
 * tag > active anchor). This locks the helper's contract so the signal can't silently drift
 * from the ONE tag→edge mapping (tagToEdgeIntent) it delegates to:
 *   - `task:` / `decision:` (trust-bearing → informs / decided_by) ⇒ TRUE (suppress anchor),
 *   - `context:` (learned_from, OFF the trust walk) ⇒ FALSE (does NOT suppress the anchor),
 *   - lens/label tags (ref:/scope:/owner:/tranche:) and plain tags ⇒ FALSE,
 *   - case/whitespace-insensitive (mirrors tagToEdgeIntent's normalization),
 *   - empty / undefined ⇒ FALSE.
 *
 * SOURCE-AWARE since the answer depends on WHO wrote the tag, because the
 * tag→edge mapping does (config/tagEdgeConfig.ts). Every case above is pinned for the
 * `context` source (the live caller — behaviour unchanged, byte for byte), and the
 * source-DEPENDENCE itself is pinned in its own block below.
 *
 * Pure (no DB, no embeddings) — it only inspects tag strings.
 */

import { describe, test, expect } from 'vitest';
import { hasTrustThreadingTag } from '../services/links.js';

describe('hasTrustThreadingTag — the explicit-tag-beats-anchor precedence signal', () => {
  test('a `task:` tag is a trust-threading tag → TRUE', () => {
    expect(hasTrustThreadingTag(['task:6907f00d'], 'context')).toBe(true);
  });

  test('a `decision:` tag is a trust-threading tag → TRUE', () => {
    expect(hasTrustThreadingTag(['decision:0a3ef00d'], 'context')).toBe(true);
  });

  test('detects a trust tag among unrelated tags', () => {
    expect(hasTrustThreadingTag(['ref:resume', 'scope:mcp', 'task:abc1234'], 'context')).toBe(true);
  });

  test('a `context:` tag (learned_from, off the trust walk) does NOT suppress the anchor → FALSE', () => {
    expect(hasTrustThreadingTag(['context:11111111-1111-4111-8111-111111111111'], 'context')).toBe(false);
  });

  test('lens/label tags and plain tags are NOT trust-threading tags → FALSE', () => {
    expect(hasTrustThreadingTag(['ref:north-star', 'scope:runtime', 'owner:coordinator', 'tranche:1', 'mandrel-tools'], 'context')).toBe(false);
  });

  test('case- and whitespace-insensitive (mirrors tagToEdgeIntent normalization)', () => {
    expect(hasTrustThreadingTag(['  TASK:ABCD1234  '], 'context')).toBe(true);
    expect(hasTrustThreadingTag(['Decision:ABCD1234'], 'context')).toBe(true);
  });

  test('empty / undefined tags → FALSE', () => {
    expect(hasTrustThreadingTag([], 'context')).toBe(false);
    expect(hasTrustThreadingTag(undefined, 'context')).toBe(false);
  });

  // ── SOURCE-DEPENDENCE ───────────────────────────────────────
  describe('the SAME tag answers differently depending on the source record type', () => {
    test('`task:` is trust-bearing from a context/decision but NOT from a TASK', () => {
      // From a context or decision, `task:` mints `informs` — an OUTCOME edge, so it
      // outranks the anchor.
      expect(hasTrustThreadingTag(['task:6907f00d'], 'context')).toBe(true);
      expect(hasTrustThreadingTag(['task:6907f00d'], 'decision')).toBe(true);
      // From a TASK, the same tag mints the weak `related_to` (the ambiguous task→task
      // case). That is NOT evidence, so it must NOT be treated as a trust-threading tag.
      // The OLD source-blind predicate ("the referent is a task or decision") answered
      // TRUE here — this is the exact behaviour the matrix corrects.
      expect(hasTrustThreadingTag(['task:6907f00d'], 'task')).toBe(false);
    });

    test('`decision:` is trust-bearing from EVERY source, including a task', () => {
      // decided_by explicitly lists task as a valid source (edgeTypes.ts), and it IS an
      // outcome edge — a task ladders up to the decision that authorized it.
      expect(hasTrustThreadingTag(['decision:0a3ef00d'], 'task')).toBe(true);
    });

    test('`context:` is trust-bearing from NO source (learned_from is off the trust walk)', () => {
      const ctxTag = ['context:11111111-1111-4111-8111-111111111111'];
      expect(hasTrustThreadingTag(ctxTag, 'context')).toBe(false);
      expect(hasTrustThreadingTag(ctxTag, 'decision')).toBe(false);
      expect(hasTrustThreadingTag(ctxTag, 'task')).toBe(false);
    });
  });
});
