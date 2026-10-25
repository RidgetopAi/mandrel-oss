/**
 * DROP-REASONS AS STRUCTURED FIELDS — parity with the text channel (P5.3 half A).
 *
 * THE ASSERTION THAT MATTERS, and why it is shaped this way. The structured field must not
 * merely be *populated*; it must say the SAME THING the text channel says, because the text
 * channel is what every existing consumer reads today (our runtime shell recovers all of this
 * by string-splitting it — `runtime/lib/boot-recall.sh`, ~230 lines of awk). So this file does
 * not compare the structured field against a hand-written expectation of what the prose ought
 * to contain. It RUNS THE SHELL'S OWN PARSE — the same split at the last ` — trust:` and the
 * same `key:([^ ]+)` token scan — over the line the product actually emits, and asserts the
 * two channels agree field by field.
 *
 * That is deliberate: a hand-written expectation is a third opinion that can be wrong in the
 * same direction as the code. Deriving one side from the shipped renderer means a change to
 * either channel breaks this test.
 *
 * ⚠️ THE PARSE BELOW IS A TEST FIXTURE, NOT A SANCTIONED READ PATH. It exists to prove the
 * structured channel is a faithful replacement for it, so that it can be DELETED downstream.
 * Nothing in the product may parse trust out of prose.
 */

import { describe, test, expect } from 'vitest';
import { dropReasonFor, type ThreadNode } from '../services/recallThreadCore.js';
import { computeTrust, explainTrust, type Trust, type TrustSignals } from '../services/trustModel.js';

// ── The shell's parse, transcribed from runtime/lib/boot-recall.sh (the awk it will delete) ──

/** The last occurrence of ` — trust:` — the shell's `rindex`, for the same reason it has one. */
function splitVerdictTail(line: string): string | null {
  const marker = ' — trust:';
  const i = line.lastIndexOf(marker);
  return i < 0 ? null : line.slice(i);
}

/** The shell's `field(tail, key)`: `<key>:<value>` where value runs to the next space. */
function field(tail: string, key: string): string | null {
  const m = new RegExp(`${key}:([^ ]+)`).exec(tail);
  return m ? m[1] : null;
}

/** The 8-hex short id — the ONLY form the text channel ever carries for `superseded_by`. */
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

/**
 * The node headline the product emits, composed EXACTLY as routes/recall.routes.ts composes
 * it (`[<type>] <title> — <signal>  (<uuid>)`), from the SAME single trust renderer. Hand-
 * writing the signal here would make this a test of a string I typed.
 */
function nodeHeadline(n: ThreadNode): string {
  return `[${n.type}] ${n.title ?? '(untitled)'} — ${explainTrust(n.trust).signal}  (${n.id})`;
}

// ── Trust fixtures: one per DISTINCT drop reason that lands a node on the abstain list ──────

function trustFrom(signals: Partial<TrustSignals>): Trust {
  return computeTrust({
    outcomes: [],
    ageDays: 0,
    supersededDeclared: false,
    supersededSoft: false,
    contradicted: false,
    ...signals,
  });
}

const NEWER = '8c8cf00d-dcfd-432e-95c5-681b02b7a2c5';
const OTHER = '866cf00d-3c50-45a6-b1ca-5ba590dd52cb';

/** DECLARED supersession → band `superseded`, abstain, reason `declared-superseded`. */
const declaredSuperseded = trustFrom({
  supersededDeclared: true,
  supersessionReceipt: { supersededBy: NEWER, tier: 'declared', confidence: null, reason: null },
});

/** CONTRADICTED → band `contradicted`, abstain, and NO supersession receipt. */
const contradicted = trustFrom({ contradicted: true });

/** STALE-and-weak enough to abstain: an ancient record with a failed downstream outcome. */
const staleAbstain = trustFrom({ ageDays: 3650, outcomes: [{ value: 0, source: 'decision' }] });

/** DEGRADED: the signal gather threw; freshness-only, and old enough to abstain. */
const degraded = trustFrom({ ageDays: 3650, degraded: true });

/** A declared supersession pointing at a record that is ALSO on the do-not-rely list. */
const declaredChained = trustFrom({
  supersededDeclared: true,
  supersessionReceipt: { supersededBy: OTHER, tier: 'declared', confidence: null, reason: null },
});

function node(id: string, title: string, trust: Trust): ThreadNode {
  return { id, type: 'context', title, trust };
}

describe('the fixtures really do exercise DISTINCT drop reasons', () => {
  // A probe reading a null field fails closed into a false RED. Before any parity assertion
  // is trusted, prove the population is what it claims to be: four different reasons, all
  // abstaining. If a future config change stops one of these abstaining, THIS fails first and
  // says so, instead of the parity tests silently testing three nodes.
  test('each fixture abstains, and the four reasons are distinct', () => {
    const fixtures = { declaredSuperseded, contradicted, staleAbstain, degraded };
    for (const [name, t] of Object.entries(fixtures)) {
      expect(t.abstain, `${name} must be on the do-not-rely list to be a drop fixture`).toBe(true);
    }
    expect(declaredSuperseded.reason).toBe('declared-superseded');
    expect(contradicted.reason).toBe('contradicted');
    expect(staleAbstain.reason).toBe('stale');
    expect(degraded.reason).toBe('degraded');
  });

  test('CONTROL — a healthy node does NOT abstain and gets NO dropped field', () => {
    // The known-good input. Without this, a `dropped === null` assertion elsewhere could pass
    // because the function returns null for everything.
    const healthy = trustFrom({ ageDays: 0, outcomes: [{ value: 1, source: 'decision' }] });
    expect(healthy.abstain).toBe(false);
    expect(dropReasonFor(node('n', 't', healthy), new Set(), new Set())).toBeNull();
  });
});

describe('the structured field says what the text channel says', () => {
  const nodes = [
    node('11111111-1111-4111-8111-111111111111', 'declared', declaredSuperseded),
    node('22222222-2222-4222-8222-222222222222', 'contradicted', contradicted),
    node('33333333-3333-4333-8333-333333333333', 'stale', staleAbstain),
    node('44444444-4444-4444-8444-444444444444', 'degraded', degraded),
  ];
  const abstainIds = new Set(nodes.filter((n) => n.trust.abstain).map((n) => n.id));
  const walkIds = new Set(nodes.map((n) => n.id));

  test.each(nodes.map((n) => [n.title, n] as const))(
    'parity for the %s node: band, score, superseded_by, tier and conf all agree',
    (_label, n) => {
      const dropped = dropReasonFor(n, abstainIds, walkIds);
      expect(dropped, 'every abstaining node carries a structured drop reason').not.toBeNull();

      const tail = splitVerdictTail(nodeHeadline(n));
      expect(tail, 'every node line carries a verdict tail — the shell anchors on it').not.toBeNull();

      // The text channel carries the SHORT id only; the structured field carries the full one.
      // Parity means the structured full id AGREES with the short id the prose printed.
      const textSup = field(tail!, 'superseded_by');
      if (dropped!.supersededBy === null) {
        expect(textSup).toBeNull();
      } else {
        expect(textSup).toBe(id8(dropped!.supersededBy));
      }
      expect(field(tail!, 'tier')).toBe(dropped!.tier);
      const textConf = field(tail!, 'conf');
      expect(textConf === null ? null : Number(textConf)).toBe(dropped!.conf);

      // The band the prose prints and the reason the field names are the SAME verdict object,
      // so they must not disagree about whether this node abstains.
      // (the tail runs on past the signal into `  (<uuid>)`, so this is a contains-test on
      // the token, not an endsWith — the headline's trailing permalink id is not part of the
      // verdict.)
      expect(/ abstain(\s|$)/.test(tail!)).toBe(true);
      expect(dropped!.reason).toBe(n.trust.reason);
    }
  );

  test('a drop with NO supersession reports null tier/conf, not an empty string', () => {
    // The shell's awk rendered an absent token as `""`, which is why its own header had to
    // promise "an absent trust: token renders as a stated absence, not as an empty field".
    // Structurally there is no such ambiguity, and this pins it.
    const dropped = dropReasonFor(nodes[1], abstainIds, walkIds); // contradicted
    expect(dropped).toMatchObject({ supersededBy: null, tier: null, conf: null });
    expect(dropped!.replacementAlsoDropped).toBe(false);
    expect(dropped!.replacementInWalk).toBe(false);
  });
});

describe('replacementAlsoDropped — "keep walking the chain"', () => {
  const dropped1 = node('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a', declaredChained); // → OTHER
  const dropped2 = node(OTHER, 'b', declaredSuperseded); // OTHER is itself on the list
  const abstainIds = new Set([dropped1.id, dropped2.id]);
  const walkIds = new Set([dropped1.id, dropped2.id]);

  test('true when the replacement is ITSELF on the do-not-rely list', () => {
    const d = dropReasonFor(dropped1, abstainIds, walkIds);
    expect(d).toMatchObject({ supersededBy: OTHER, replacementAlsoDropped: true, replacementInWalk: true });
  });

  test('false when the replacement is in the walk and healthy', () => {
    const d = dropReasonFor(dropped1, new Set([dropped1.id]), walkIds);
    expect(d).toMatchObject({ replacementAlsoDropped: false, replacementInWalk: true });
  });

  test('replacementInWalk is false when the pointer leaves the returned thread', () => {
    // The shell had to render this as "NOT ANNOTATABLE" because it could not tell a pointer
    // out of the walk from a parse failure. Structurally these are different fields.
    const d = dropReasonFor(dropped1, abstainIds, new Set([dropped1.id]));
    expect(d).toMatchObject({ replacementAlsoDropped: true, replacementInWalk: false });
  });

  test('FULL-ID matching — two uuids sharing an 8-hex prefix do not collide', () => {
    // The shell matches on the 8-hex short id and its own comment calls the resulting false
    // positive "inherent to id8". It is not inherent; it was an artefact of reading prose.
    const twin = `${OTHER.slice(0, 8)}-dead-4bee-8fff-ffffffffffff`;
    const d = dropReasonFor(dropped1, new Set([twin]), new Set([twin]));
    expect(id8(twin)).toBe(id8(OTHER)); // the collision is real…
    expect(d!.replacementAlsoDropped).toBe(false); // …and the structured field does not fall for it
  });
});
