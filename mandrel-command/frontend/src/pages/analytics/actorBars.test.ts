/**
 * The by-actor panel's ARITHMETIC, asserted as pure functions.
 *
 * WHY HERE AND NOT IN THE RENDER TEST. All of this decides what a viewer reads, and all of
 * it is invisible to jsdom: the roll-up label is an SVG axis tick (recharts draws nothing
 * in a 0x0 ResponsiveContainer) and the coverage wording depends on a threshold that no
 * DOM assertion pins down. an earlier Task already paid for this once — a jsdom tick-count
 * guard there stayed GREEN with the fix reverted. So the numbers are proved here, the
 * layout is proved by browser screenshots, and neither pretends to be the other.
 *
 * THE PROPERTY THAT MATTERS is conservation: the drawn bars must still sum to the figure
 * the coverage line prints. A roll-up that DROPS the tail instead of folding it would
 * leave the chart and the sentence disagreeing, which is the exact failure this panel was
 * designed to remove. It is asserted below across the whole partition, not per group,
 * because the split is where a conserved total is easiest to lose.
 */
import { describe, it, expect } from 'vitest';
import {
  rollUpActors,
  partitionByKind,
  sharedValueDomain,
  tintHex,
  type RollUpRule,
} from './ActorBars';
import { ACTOR_ACTIVITY, ACTOR_MUTED_TINT } from './config';
import { coverageState, coveragePercent } from '../../components/common/CoverageNote';
import { themes } from '../../styles/tokens';
import { compactNumber, valueAxisConfig } from '../../components/charts';
import type { ActorContextCount, ActorKind } from '../../api/domains/sessions';

const actors = (counts: number[], kind: ActorKind | null = 'agent'): ActorContextCount[] =>
  counts.map((n, i) => ({ actor: `actor-${i}`, context_count: n, kind }));

/** The rule the panel actually renders with — read from config, never restated here. */
const SHIPPING_RULE: RollUpRule = {
  minShareOfLargest: ACTOR_ACTIVITY.minShareOfLargest,
  maxBars: ACTOR_ACTIVITY.maxBars,
};

describe('rollUpActors — folded by SHARE, never dropped', () => {
  it('passes every actor through when they are all above the share floor', () => {
    const rows = rollUpActors(actors([100, 90, 80]), { minShareOfLargest: 0.5, maxBars: 12 });
    expect(rows).toEqual([
      { label: 'actor-0', count: 100, isOther: false },
      { label: 'actor-1', count: 90, isOther: false },
      { label: 'actor-2', count: 80, isOther: false },
    ]);
  });

  it('folds everything BELOW the share floor into ONE bar carrying their combined count', () => {
    // THE MEASURED DEFECT (reports/artifacts/actor-bars-b004dad2/01-…png): at topN=8 the
    // live chart drew four sub-pixel bars ABOVE an "Other (7 actors)" row. Those four are
    // `anonymous`(9) and three `builder-*`(3,2,2) against a leader of 730 — every one of
    // them under 2% of the largest, and every one of them individually invisible.
    const rows = rollUpActors(
      actors([730, 656, 437, 227, 9, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1]),
      SHIPPING_RULE,
    );
    expect(rows.filter((r) => !r.isOther).map((r) => r.count)).toEqual([730, 656, 437, 227]);
    const other = rows[rows.length - 1];
    expect(other.isOther).toBe(true);
    expect(other.label).toBe('Other (11 actors)');
    expect(other.count).toBe(9 + 3 + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1);
  });

  it('a bar exactly AT the floor is drawn; one just below is folded', () => {
    // 2% of 1000 is 20. The boundary is the whole point of a threshold rule.
    const rows = rollUpActors(
      [
        { actor: 'lead', context_count: 1000, kind: 'agent' },
        { actor: 'at-floor', context_count: 20, kind: 'agent' },
        { actor: 'below', context_count: 19, kind: 'agent' },
      ],
      { minShareOfLargest: 0.02, maxBars: 12 },
    );
    expect(rows.map((r) => r.label)).toEqual(['lead', 'at-floor', 'Other (1 actor)']);
  });

  it('maxBars is a CEILING, not the primary rule: it folds the overflow it cuts', () => {
    const rows = rollUpActors(actors([10, 10, 10, 10, 10]), {
      minShareOfLargest: 0,
      maxBars: 2,
    });
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({ label: 'Other (3 actors)', count: 30, isOther: true });
  });

  it('does not depend on the input being sorted DESC', () => {
    const rows = rollUpActors(
      [
        { actor: 'small', context_count: 1, kind: 'agent' },
        { actor: 'huge', context_count: 1000, kind: 'agent' },
      ],
      { minShareOfLargest: 0.02, maxBars: 12 },
    );
    // The floor is read off the LARGEST, wherever it sits — not off `actors[0]`.
    expect(rows.map((r) => r.label)).toEqual(['huge', 'Other (1 actor)']);
  });

  it('the EMPTY population yields no bars and no "Other"', () => {
    expect(rollUpActors([], SHIPPING_RULE)).toEqual([]);
  });

  it('an ALL-ZERO population keeps every bar rather than folding them all away', () => {
    // The zero population is the one that slips through: with `largest === 0` the floor is
    // 0, and a `> floor` comparison would send every actor into "Other" — a chart of one
    // grey bar labelled "Other (3 actors)" for data that is simply all zero.
    const rows = rollUpActors(actors([0, 0, 0]), SHIPPING_RULE);
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.isOther)).toBe(false);
  });

  it('a single folded actor is labelled in the singular', () => {
    const rows = rollUpActors(actors([100, 1]), { minShareOfLargest: 0.5, maxBars: 12 });
    expect(rows[rows.length - 1].label).toBe('Other (1 actor)');
  });
});

describe('partitionByKind — two groups, and unknown is NEITHER', () => {
  const population: ActorContextCount[] = [
    { actor: 'coordinator-alert-sink', context_count: 730, kind: 'automation' },
    { actor: 'tick', context_count: 656, kind: 'automation' },
    { actor: 'coordinator', context_count: 437, kind: 'agent' },
    { actor: 'operator', context_count: 227, kind: 'human' },
    { actor: 'mystery-bot', context_count: 99, kind: null },
  ];

  it('human and agent are ONE group; automation is the other', () => {
    const p = partitionByKind(population);
    expect(p.user_driven.map((a) => a.actor)).toEqual(['coordinator', 'operator']);
    expect(p.automated.map((a) => a.actor)).toEqual(['coordinator-alert-sink', 'tick']);
  });

  it('an actor of UNKNOWN kind is in no group — it is the coverage line, not a bar', () => {
    const p = partitionByKind(population);
    const drawn = [...p.user_driven, ...p.automated].map((a) => a.actor);
    expect(drawn).not.toContain('mystery-bot');
  });

  it('the EMPTY population yields two empty groups, not undefined ones', () => {
    expect(partitionByKind([])).toEqual({ user_driven: [], automated: [] });
  });

  it('CONSERVES the classified total across the split AND the roll-up, at any threshold', () => {
    const classified = population
      .filter((a) => a.kind !== null)
      .reduce((s, a) => s + a.context_count, 0);
    for (const minShareOfLargest of [0, 0.02, 0.25, 0.9, 1]) {
      for (const maxBars of [1, 2, 12, 40]) {
        const p = partitionByKind(population);
        const drawn =
          rollUpActors(p.user_driven, { minShareOfLargest, maxBars }).reduce(
            (s, r) => s + r.count,
            0,
          ) +
          rollUpActors(p.automated, { minShareOfLargest, maxBars }).reduce(
            (s, r) => s + r.count,
            0,
          );
        expect(drawn, `share=${minShareOfLargest} maxBars=${maxBars}`).toBe(classified);
      }
    }
  });
});

describe('coverageState / coveragePercent — the boundaries the wording turns on', () => {
  it('nothing classified is `none`, even with a large total (the onboarding case)', () => {
    expect(coverageState(0, 3013)).toBe('none');
    expect(coverageState(0, 0)).toBe('none');
  });

  it('a partial slice is `partial`, and the percent FLOORS', () => {
    expect(coverageState(1204, 3013)).toBe('partial');
    expect(coveragePercent(1204, 3013)).toBe(39); // 39.96% must not read as 40 or 100
  });

  it('everything classified is `full`', () => {
    expect(coverageState(10, 10)).toBe('full');
    expect(coveragePercent(10, 10)).toBe(100);
  });

  it('just under the threshold stays `partial`; at it, `full`', () => {
    expect(coverageState(98, 100, 0.99)).toBe('partial');
    expect(coverageState(99, 100, 0.99)).toBe('full');
  });

  it('a zero total never divides by zero', () => {
    expect(coveragePercent(0, 0)).toBe(0);
  });
});

describe('colour encodes the GROUP — never a literal, and no longer an identity', () => {
  it('each group tint resolves to its token value for the active theme', () => {
    for (const g of ACTOR_ACTIVITY.groups) {
      const key = g.tintVar.replace(/^--/, '');
      expect(tintHex('dark', g.tintVar), g.id).toBe(themes.dark[key]);
      expect(tintHex('light', g.tintVar), g.id).toBe(themes.light[key]);
    }
  });

  it('the two groups do NOT share a hue — the split is the thing colour must carry', () => {
    const [a, b] = ACTOR_ACTIVITY.groups;
    expect(tintHex('dark', a.tintVar)).not.toBe(tintHex('dark', b.tintVar));
    expect(tintHex('light', a.tintVar)).not.toBe(tintHex('light', b.tintVar));
  });

  it('the roll-up bucket takes the muted token, distinct from both groups', () => {
    const muted = tintHex('dark', ACTOR_MUTED_TINT);
    expect(muted).toBe(themes.dark['tx-3']);
    for (const g of ACTOR_ACTIVITY.groups) {
      expect(tintHex('dark', g.tintVar)).not.toBe(muted);
    }
  });

  it('an unknown token name degrades to the muted value rather than to undefined', () => {
    // An undefined fill makes recharts paint black on a dark ground — an invisible bar.
    expect(tintHex('dark', '--not-a-token')).toBe(themes.dark['tx-3']);
  });
});

/**
 * ── THE VALUE-AXIS FORMATTER (addition 3) ─────────────────────────────
 * The rhythm panel's y-axis rendered `00000` four times against prod numbers: eight-digit
 * ticks printed in full into a 36px gutter and clipped to their tails. What is provable
 * WITHOUT a browser is that a formatted tick now fits the axis's own character budget;
 * that the rendered axis is legible is proved by screenshot, because clipping is layout.
 */
describe('valueAxisConfig — a numeric tick fits the gutter it is drawn in', () => {
  it('formats large magnitudes compactly instead of printing every digit', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(20_000_000)).toBe('20M');
    expect(compactNumber(115_515_738)).toBe('115.5M');
  });

  it('every tick of the measured prod series fits the budget the axis reserves', () => {
    const { width, tickFormatter } = valueAxisConfig();
    // The same estimate the axis width is derived from: chars * fontSize * charWidthRatio.
    const fits = (label: string) => label.length <= 8;
    for (const v of [0, 20_000_000, 40_000_000, 60_000_000, 115_515_738, -7_500_000]) {
      const label = String(tickFormatter(v));
      expect(label, `tick ${v} -> ${label}`).toSatisfy(fits);
    }
    expect(width).toBeGreaterThan(30);
  });

  it('passes a non-numeric tick through rather than rendering an em dash', () => {
    const { tickFormatter } = valueAxisConfig();
    expect(tickFormatter('auto')).toBe('auto');
  });
});

/**
 * ── THE SHARED VALUE DOMAIN (reject round 1) ──────────────────────────
 * The two groups were drawn on independent axes, so a 57-context human bar and a
 * 120-context alert sink rendered the same length. What is provable WITHOUT a browser is
 * the domain ARITHMETIC — one ceiling, taken from the largest bar in either group, and
 * unaffected by the per-group roll-up floor. That the two charts are actually DRAWN
 * against it is a layout fact, proved by the matched browser pair in
 * reports/artifacts/tokens-5219eb75/08-BEFORE-… / 09-AFTER-….
 */
describe('sharedValueDomain — one ceiling for both groups', () => {
  it('takes the largest DRAWN bar across BOTH groups, from either side', () => {
    const user = [{ label: 'operator', count: 57, color: '#0' }];
    const auto = [{ label: 'coordinator-alert-sink', count: 120, color: '#0' }];
    // The measured case: automation is larger, and it is what must set the ceiling.
    expect(sharedValueDomain([user, auto])).toEqual([0, 120]);
    // And symmetrically — the ceiling is not "the automated group's max".
    expect(sharedValueDomain([auto.map((r) => ({ ...r, count: 3 })), user])).toEqual([0, 57]);
  });

  it('always starts at zero — a non-zero floor exaggerates every difference', () => {
    expect(sharedValueDomain([[{ label: 'a', count: 900, color: '#0' }]])[0]).toBe(0);
  });

  it('an EMPTY population, and an ALL-ZERO one, yield [0, 0] rather than a fabricated top', () => {
    expect(sharedValueDomain([])).toEqual([0, 0]);
    expect(sharedValueDomain([[], []])).toEqual([0, 0]);
    expect(sharedValueDomain([[{ label: 'a', count: 0, color: '#0' }]])).toEqual([0, 0]);
  });

  it('bounds the ROLLED-UP rows, which can exceed any single actor they folded', () => {
    // The reason this takes drawn rows and not raw actors: an "Other" bar is a sum.
    const rows = rollUpActors(actors([100, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]), {
      minShareOfLargest: 0.5,
      maxBars: 12,
    }).map((r) => ({ label: r.label, count: r.count, color: '#0' }));
    const other = rows[rows.length - 1];
    expect(other.count).toBe(126);
    expect(sharedValueDomain([rows])).toEqual([0, 126]);
  });

  it('the roll-up floor is STILL per-group — sharing the axis must not share the floor', () => {
    // A 2%-of-largest floor measured across both groups would fold every human bar under
    // an alert sink. Same inputs, same outputs as before the domain was shared.
    const p = partitionByKind([
      { actor: 'coordinator-alert-sink', context_count: 730, kind: 'automation' },
      { actor: 'quiet-human', context_count: 12, kind: 'human' },
    ]);
    expect(rollUpActors(p.user_driven, SHIPPING_RULE)).toEqual([
      { label: 'quiet-human', count: 12, isOther: false },
    ]);
  });
});
