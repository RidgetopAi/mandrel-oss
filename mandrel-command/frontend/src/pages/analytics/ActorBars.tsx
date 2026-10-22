/**
 * ActorBars — "Activity by actor", split USER-DRIVEN vs AUTOMATED
 *. LIVE from `GET /api/sessions/contexts-by-actor`: contexts created in
 * the pivot window, grouped by the owning session's actor, each actor carrying the kind
 * the SERVER classified it as.
 *
 * ── WHY THE SPLIT ────────────────────────────────────────────────────────────────────
 * Measured on prod (reports/artifacts/actor-bars-b004dad2/01-…png): the two longest bars
 * on this chart were `coordinator-alert-sink` and `tick` — machinery — with every human and
 * agent bar compressed underneath them. A single ranking answers "who wrote the most
 * rows", which automation always wins and which nobody needs to be told. The operator's ask was
 * the other question: "you can see what work was with user or user controlled and what is
 * automated." Two groups, drawn as two charts — on ONE shared value axis.
 *
 * ── ONE SHARED VALUE DOMAIN, AND WHY THAT IS NOT NEGOTIABLE ──────────────────────────
 * The groups were first drawn each scaled to itself, which is wrong for the question the
 * panel exists to answer. Measured in a browser (reports/artifacts/tokens-5219eb75/
 * 08-BEFORE-…png): the user-driven axis ran 0–60 and the automated axis 0–120, so `operator`
 * (57 contexts) and `coordinator-alert-sink` (120) drew the SAME pixel length. That destroys the
 * between-group reading and keeps only the secondary within-group one, and it errs in the
 * direction that understates automation — the single fact the split was built to surface.
 * The misstatement was 2x on that data and it is scale-free: at 10x the bars still match.
 * So both charts take `sharedValueDomain(...)`. Only the DRAWING is shared — the roll-up
 * arithmetic stays per-group (see `rollUpActors`).
 *
 * ── "UNASSIGNED" IS NOT A BAR, AND NEITHER IS "UNKNOWN KIND" ─────────────────────────
 * A context whose session carries no actor is the ABSENCE of the dimension this chart is
 * about. So is a context whose actor the registry does not recognise: it has a name, but
 * not the classification the two groups are made of, and inventing a third "Unknown"
 * series would make a registry gap look like a kind of work. Both are excluded from the
 * bars and stated above them by the shared `CoverageNote`, in the SAME UNIT the bars use.
 * The rejected alternative was a filter-out toggle: for a tenant sending no `X-Actor-ID`
 * that yields an empty chart whose "no data" empty state is false — they have data, they
 * have no actor on it. That case is the CoverageNote's zero-coverage prompt, and the
 * chart is honestly empty underneath it.
 *
 * ── THE TAIL IS ROLLED UP BY SHARE, NOT BY RANK, AND NEVER DROPPED ───────────────────
 * See `ACTOR_ACTIVITY.minShareOfLargest` in config.ts for the measurement that retired
 * the top-N cut. The roll-up runs PER GROUP against that group's own largest bar, so a
 * quiet human actor is never rolled up for being small next to an alert sink. Actor slugs
 * are rendered VERBATIM — `builder-6ca299d9` is its own actor, and folding it into
 * `builder` would be a claim about identity, not formatting.
 */
import React from 'react';
import { BarChartCard, useChartTheme } from '../../components/charts';
import { Empty, Text } from '../../components/ui';
import { CoverageNote, coverageState } from '../../components/common/CoverageNote';
import { Panel, Provenance } from './parts';
import { ActorIcon } from './icons';
import { ACTOR_ACTIVITY, ACTOR_MUTED_TINT, groupIdForKind, type ActorGroupId } from './config';
import { themes, type ThemeName } from '../../styles/tokens';
import type { ContextsByActor, ActorContextCount } from '../../api/domains/sessions';
import styles from './Analytics.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ActorBarsProps {
  data: ContextsByActor | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

/** One drawn bar. `color` is a RESOLVED hex — BarChartCard paints recharts Cells with it. */
export interface ActorBarRow {
  label: string;
  count: number;
  color: string;
}

/**
 * Resolve a design-token CSS-var NAME (`'--teal'`) to the concrete hex for a theme.
 *
 * Colour is authored as a token name everywhere on this page (guarded by
 * Analytics.wiring.test.ts / charts.guards.test.ts) but recharts sets `fill` as an SVG
 * PRESENTATION ATTRIBUTE, where `var(--teal)` does not resolve. So the var name is the
 * source and this is the single resolution step — never a hex literal in a component.
 */
export function tintHex(theme: ThemeName, tintVar: string): string {
  return themes[theme][tintVar.replace(/^--/, '')] ?? themes[theme]['tx-3'];
}

/**
 * Partition the server's actor rows into the two drawn groups.
 *
 * An actor with `kind: null` belongs to NEITHER — it is returned nowhere, because the
 * coverage line is what states it. Exported so the partition is provable without a DOM.
 *
 * The kind → group rule itself is `groupIdForKind` in config.ts: the
 * most-active-sessions panel asks the same question, and it must get the same answer.
 */
export function partitionByKind(
  actors: ActorContextCount[],
): Record<ActorGroupId, ActorContextCount[]> {
  const out: Record<ActorGroupId, ActorContextCount[]> = { user_driven: [], automated: [] };
  for (const a of actors) {
    const group = groupIdForKind(a.kind);
    if (group) out[group].push(a);
  }
  return out;
}

/** How a roll-up is parameterised. Both bounds come from config, never from a literal. */
export interface RollUpRule {
  /** Minimum share OF THE LARGEST BAR IN THIS LIST for a bar to be drawn on its own. */
  minShareOfLargest: number;
  /** Hard ceiling on drawn bars, applied after the share threshold. */
  maxBars: number;
}

/**
 * Fold every actor below the share threshold into ONE "Other" bar.
 *
 * Pure and exported so the roll-up ARITHMETIC is testable without a DOM: the property
 * that matters is CONSERVATION — the drawn bars must still sum to the input's total, i.e.
 * the roll-up never drops a row it merely stops naming.
 *
 * The threshold is measured against the largest count in the list PASSED IN, which is why
 * the caller passes one group at a time: measured against the whole population, a 2%
 * floor set by an alert sink would silently roll up every human on the chart.
 */
export function rollUpActors(
  actors: ActorContextCount[],
  rule: RollUpRule,
): Array<{ label: string; count: number; isOther: boolean }> {
  if (actors.length === 0) return [];
  // The server orders by count DESC, but this must not DEPEND on that: a threshold read
  // off `actors[0]` would be wrong for any caller that sorted differently.
  const largest = actors.reduce((m, a) => Math.max(m, a.context_count), 0);
  const floor = largest * rule.minShareOfLargest;

  const kept: ActorContextCount[] = [];
  const folded: ActorContextCount[] = [];
  for (const a of actors) {
    // `>= floor` and never a bare `> 0`: with an all-zero population `largest` is 0, the
    // floor is 0, and every bar is kept rather than every bar vanishing into "Other".
    if (a.context_count >= floor && kept.length < rule.maxBars) kept.push(a);
    else folded.push(a);
  }

  const rows = kept.map((a) => ({ label: a.actor, count: a.context_count, isOther: false }));
  if (folded.length === 0) return rows;
  return [
    ...rows,
    {
      label: ACTOR_ACTIVITY.otherLabel(folded.length),
      count: folded.reduce((sum, a) => sum + a.context_count, 0),
      isOther: true,
    },
  ];
}

/**
 * The ONE value domain both group charts draw against: `[0, largest drawn bar in EITHER
 * group]`. See the "one shared value domain" note at the top of this file for the measured
 * defect it closes.
 *
 * Takes the DRAWN rows (post-roll-up), not the raw actors, because the axis must bound
 * what is actually on screen — an "Other" bar can exceed any single actor it folded.
 * Zero rows, or an all-zero population, yields `[0, 0]`: honest for data that is all zero,
 * and never a fabricated non-zero ceiling.
 */
export function sharedValueDomain(groupRows: ActorBarRow[][]): [number, number] {
  let max = 0;
  for (const rows of groupRows) for (const r of rows) max = Math.max(max, r.count);
  return [0, max];
}

/** Chart height that gives every bar a legible band, never below the panel norm. */
export function actorBarsHeight(rowCount: number): number {
  return Math.max(
    ACTOR_ACTIVITY.minHeight,
    rowCount * ACTOR_ACTIVITY.rowHeight + ACTOR_ACTIVITY.axisChrome,
  );
}

export const ActorBars: React.FC<ActorBarsProps> = ({ data, isLoading, isError, error }) => {
  const ct = useChartTheme();

  const total = data?.total_contexts ?? 0;
  // The coverage line's numerator is what the BARS can account for: contexts whose actor
  // the registry classified. Everything else — no actor, or an actor of unknown kind — is
  // the remainder the sentence states.
  const classified = (data?.user_driven_contexts ?? 0) + (data?.automated_contexts ?? 0);
  const partition = partitionByKind(data?.actors ?? []);
  const rule: RollUpRule = {
    minShareOfLargest: ACTOR_ACTIVITY.minShareOfLargest,
    maxBars: ACTOR_ACTIVITY.maxBars,
  };

  const groups = ACTOR_ACTIVITY.groups.map((g) => {
    const rows: ActorBarRow[] = rollUpActors(partition[g.id], rule).map((r) => ({
      label: r.label,
      count: r.count,
      // The roll-up bar is not an actor, so it takes the muted tone rather than the
      // group's hue, which here reads as an identity claim about a bucket.
      color: tintHex(ct.theme, r.isOther ? ACTOR_MUTED_TINT : g.tintVar),
    }));
    return { ...g, rows, subtotal: rows.reduce((s, r) => s + r.count, 0) };
  });

  const valueDomain = sharedValueDomain(groups.map((g) => g.rows));
  const state = coverageState(classified, total);

  return (
    <Panel
      icon={<ActorIcon size={15} />}
      title="Activity by actor"
      provenance={<Provenance>/api/sessions/contexts-by-actor</Provenance>}
    >
      {isError ? (
        <div className={styles.inlineError} role="alert">
          {apiErrorMessage(error, "Couldn't load activity by actor.")}
        </div>
      ) : isLoading ? (
        <BarChartCard
          data={[]}
          xKey="label" /* non-date-axis: actor slugs, a category axis */
          series={[{ key: 'count', name: ACTOR_ACTIVITY.seriesLabel }]}
          layout="vertical"
          height={actorBarsHeight(0)}
          loading
        />
      ) : total === 0 ? (
        // Genuinely nothing in the window. NOT the same statement as "nothing is
        // classified", which is why the two states are separate branches: this one is
        // the ordinary empty, the next one is an onboarding prompt.
        <Empty
          title="No contexts in this window"
          description="Nothing was written in the selected range for this project."
        />
      ) : (
        <>
          <CoverageNote
            attributed={classified}
            total={total}
            unit={ACTOR_ACTIVITY.unit}
            dimension="known actor"
            verb="classified"
          />
          {/*
            When nothing is classified the CoverageNote above IS the state — it explains
            what to do and says the records are present. Drawing an empty chart frame
            under it would re-assert "no data", which is the lie the note just corrected.
          */}
          {state === 'none'
            ? null
            : groups.map((g) => (
                <div key={g.id} className={styles.actorGroup} data-actor-group={g.id}>
                  <div className={styles.actorGroupHead}>
                    <Text variant="body" tone="default">
                      {g.label}
                    </Text>
                    <Text variant="data" tone="faintest">
                      {g.subtotal.toLocaleString()}{' '}
                      {g.subtotal === 1 ? ACTOR_ACTIVITY.unit.one : ACTOR_ACTIVITY.unit.many} ·{' '}
                      {g.note}
                    </Text>
                  </div>
                  {g.rows.length === 0 ? (
                    /*
                      An EMPTY group is stated, not hidden. "No automated actors wrote in
                      this window" is a real, useful reading of the split; silently
                      dropping the group would make a window with no automation look
                      identical to a window where the split was never computed.
                    */
                    <Text variant="body" tone="faint">
                      No {g.label.toLowerCase()} actors in this window.
                    </Text>
                  ) : (
                    <BarChartCard
                      data={g.rows as unknown as Array<Record<string, number | string>>}
                      xKey="label" /* non-date-axis: actor slugs, a category axis */
                      series={[{ key: 'count', name: ACTOR_ACTIVITY.seriesLabel }]}
                      colorKey="color"
                      layout="vertical"
                      categoryWidth={ACTOR_ACTIVITY.categoryWidth}
                      valueDomain={valueDomain}
                      height={actorBarsHeight(g.rows.length)}
                      empty={false}
                    />
                  )}
                </div>
              ))}
        </>
      )}
    </Panel>
  );
};

export default ActorBars;
