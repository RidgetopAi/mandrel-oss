/**
 * Guard test (blue-tape FIX #4, extended by an earlier task): the backend ContextTypeSchema
 * must be Mandrel's CANONICAL context types — the same set `context_store` accepts
 * (mcp-server/src/config/contextTypes.ts) and the DB CHECK constraint stores. The prior enum
 * was STALE ('research'/'issue'/'note'/'test'), so the Contexts tag/type filter 400'd for real
 * types and REST creation of those types was blocked (this one enum gates BOTH
 * ContextSearchQuerySchema and CreateContextSchema). It then drifted AGAIN — `lessons` (a
 * real type since migration 032) was missing here until `note` landed (migration 100).
 *
 * `note` is now canonical (the generic capture type). `fact` is the value the model reached
 * for in the eval and is deliberately NOT a type — pinned rejected so no one aliases it.
 */
import { ContextTypeSchema, CreateContextSchema } from '../validation/schemas';

const CANONICAL_TYPES = [
  'code', 'decision', 'error', 'discussion', 'planning',
  'completion', 'milestone', 'reflections', 'handoff', 'lessons', 'note',
] as const;

// The specific types the customer reported as broken (rejected → 400) before the fix.
const REPORTED_BROKEN = ['handoff', 'milestone', 'planning', 'completion'] as const;

describe('ContextTypeSchema — canonical context types', () => {
  it('accepts every canonical type', () => {
    for (const t of CANONICAL_TYPES) {
      expect(ContextTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('accepts the previously-broken types (handoff/milestone/planning/completion)', () => {
    for (const t of REPORTED_BROKEN) {
      expect(ContextTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it('accepts the two types this enum previously drifted away from (lessons, note)', () => {
    expect(ContextTypeSchema.safeParse('lessons').success).toBe(true);
    expect(ContextTypeSchema.safeParse('note').success).toBe(true);
  });

  it('exposes exactly the canonical set (no extra, none missing)', () => {
    expect([...ContextTypeSchema.options].sort()).toEqual([...CANONICAL_TYPES].sort());
  });

  it('rejects the stale types and the un-aliased synonym `fact`', () => {
    for (const t of ['research', 'issue', 'test', 'fact']) {
      expect(ContextTypeSchema.safeParse(t).success).toBe(false);
    }
  });
});

describe('CreateContextSchema — the same enum unbreaks REST context creation', () => {
  it.each([...REPORTED_BROKEN, 'note'])('accepts a create payload with type "%s"', (type) => {
    const result = CreateContextSchema.safeParse({
      content: 'a'.repeat(20),
      type,
    });
    expect(result.success).toBe(true);
  });
});
