/**
 * Analytics configuration — the single, named home for every Analytics-screen tunable
 * (house rule configs-not-hardcoded). Range options, the react-query staleness, the
 * KPI + hero metric vocabularies (label / trend key), the task work-mix
 * status vocabulary, the provenance vocabulary, and the productive/rhythm limits all live
 * here so the parts stay declarative and no literal leaks into a component.
 *
 * Colour is NEVER a hex literal here — every tint is a design-token CSS-var NAME
 * (`--teal`, `--green`, …) resolved at render via `var(--x)`; the charts read their
 * colours from `chartTheme` (also token-sourced). Both are guarded by
 * Analytics.wiring.test.ts / charts.guards.test.ts.
 */

/** The pivot range segmented control (mock `.fseg`). Drives every read's window. */
export const RANGE_OPTIONS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
] as const;
export type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

export const ANALYTICS_CONFIG = {
  /** Default pivot window (mock defaults the segmented control to 30d). */
  defaultRangeDays: 30 as RangeValue,
  /** react-query staleTime for every Analytics read (2 min — matches Decisions). */
  staleTimeMs: 1000 * 60 * 2,
  /** Rows requested for the "Most productive sessions" panel. */
  productiveLimit: 5,
  /** Hours in the rhythm histogram (a full day). */
  rhythmHours: 24,
  /**
   * Delta model for the KPI tiles + hero "vs prior" figure: split the active window
   * in half and compare the recent half's sum to the prior half's sum. A REAL,
   * honest intra-window trend derived from the same live series (no second fetch,
   * no fabricated baseline). Below this many points the delta is not shown.
   */
  minPointsForDelta: 4,
} as const;

/*
 * ── THE PROVENANCE VOCABULARY IS GONE ────────────────────────────────────────────────
 * (item 2; `ProvenanceKind` / `PROVENANCE_META` / `ProvenanceLegend`)
 *
 * It had three kinds and now has none, deleted one at a time for the same reason:
 *   • `wire` — "Needs 1 small add · serialize actor on read" (deleted)
 *     once the actor panel started reading a real endpoint;
 *   • `built` — "Built, unused · endpoint exists, just turn it on" (deleted here). Its
 *     only two consumers were the most-active-sessions panel and the rhythm panel, both
 *     of which are rendered, fetched, and drawing real production data ON THE PAGE THE
 *     LEGEND PRINTS ON. The b004dad2 reasoning — "a legend entry that no panel carries
 *     is not a harmless leftover" — was correct and was applied one kind short;
 *   • `live` — which, once it is the ONLY kind, carries no information at all. A legend
 *     whose every entry is true of every panel is a legend that cannot be read wrong
 *     because it cannot be read for anything. That is not harmless either: it occupies
 *     the footer slot where a real caveat would go, and it takes maintenance.
 *
 * What actually told the reader something was never the dot's colour — it was the
 * ENDPOINT PATH each panel prints next to it (`/api/sessions/trends`, `/api/tasks/stats`,
 * …). That survives, in `parts.tsx`'s `Provenance`. It cannot go stale the way a kind
 * can, because it is the request the panel makes.
 *
 * Reintroduce a kind when a SECOND state genuinely exists to name — i.e. when some panel
 * on this page is not live — and not before.
 */

/**
 * The four KPI tiles + the hero metric-toggle vocabulary. `trendKey` maps each metric to
 * its field on a SessionTrendPoint so the KPI totals, sparklines and hero all derive from
 * the ONE live `/api/sessions/trends` series.
 *
 * ── THE `MCP payload (est.)` METRIC IS GONE ─────────────────────────────────────────
 * (the operator's decision: "I don't want us to have something I can't justify
 * and that is not a serious way of measuring.")
 *
 * It plotted `sessions.total_tokens`, which is `Math.ceil(text.length / 4)` over the MCP
 * request args plus the MCP result — Mandrel's WIRE TRAFFIC, a cost/plumbing signal
 * wearing an activity label. Relabelling it (which is what an earlier task did) could not
 * fix the deeper problem: a whole session's payload is bucketed onto its START day, and a
 * session can run for a week, so most of the series was plotted on the wrong day.
 *
 * `tasksCompleted` takes its slot as the activity indicator. It does not inherit any of
 * that: `tasks.completed_at` is a real per-record timestamp, so each day's figure is the
 * work that actually finished that day. The backend series is built in
 * services/sessionAnalytics.ts `getSessionTrends`, which explains its anchoring there.
 *
 * The `compact` flag went with it. It existed to render one metric (the payload estimate)
 * in `1.2M` form; every remaining metric is a plain count of records, and a per-metric
 * flag that is false for every metric is the same dead vocabulary as the provenance
 * legend deleted above. `formatInt` is now the one formatter these tiles use.
 *
 * `tintVar` went too, and it PRE-DATES this task: it was `--teal` on all four metrics and
 * had no reader — the KPI sparkline passes the charting module a literal `tone="teal"`,
 * and the hero reads its colour from `chartTheme`. A colour field nothing renders from is
 * the kind of thing a future edit changes expecting the screen to follow.
 */
export type MetricId = 'contexts' | 'tasksCompleted' | 'tasks' | 'sessions';

export const METRICS: Record<
  MetricId,
  { label: string; trendKey: keyof import('../../api/domains/sessions').SessionTrendPoint }
> = {
  contexts: { label: 'Contexts', trendKey: 'total_contexts' },
  tasksCompleted: { label: 'Tasks completed', trendKey: 'total_tasks_completed' },
  tasks: { label: 'Tasks created', trendKey: 'total_tasks_created' },
  sessions: { label: 'Sessions', trendKey: 'session_count' },
} as const;

/** KPI tiles, in mock order (Sessions, <activity>, Contexts, Tasks-created). */
export const KPI_ORDER: MetricId[] = ['sessions', 'tasksCompleted', 'contexts', 'tasks'];

/** Hero metric-toggle order (mock: Contexts, <activity>, Tasks, Sessions). */
export const HERO_METRIC_ORDER: MetricId[] = ['contexts', 'tasksCompleted', 'tasks', 'sessions'];
export const HERO_DEFAULT_METRIC: MetricId = 'contexts';

/**
 * Work-mix task-status vocabulary (mock legend Done / In progress / Blocked / To do).
 * Keys are the REAL Postgres status enum the backend stores (`types/task.ts`). `cancelled`
 * is folded out of the mix bar by omission (never fabricated). Order = mock segment order.
 */
export type WorkMixStatus = 'completed' | 'in_progress' | 'blocked' | 'todo';

export const WORK_MIX: Array<{ status: WorkMixStatus; label: string; tintVar: string }> = [
  { status: 'completed', label: 'Done', tintVar: '--green' },
  { status: 'in_progress', label: 'In progress', tintVar: '--teal' },
  { status: 'blocked', label: 'Blocked', tintVar: '--rose' },
  { status: 'todo', label: 'To do', tintVar: '--tx-4' },
];

/**
 * The statuses that count as OPEN, DERIVED from `WORK_MIX` rather than restated.
 *
 * "Open now" is the one figure in the flow block that is not window-scoped, and it must
 * agree with the bar's own vocabulary: whatever the bar draws that is not Done is open.
 * Writing `['todo', 'in_progress', 'blocked']` out again would be a second copy of that
 * list, and a second copy is how a status added to the bar quietly stops being counted as
 * open. `cancelled` is absent from `WORK_MIX` and is therefore absent here too, which is
 * correct: a cancelled task is not open work.
 */
export const OPEN_STATUSES: WorkMixStatus[] = WORK_MIX.filter(
  (s) => s.status !== 'completed',
).map((s) => s.status);

/**
 * The Work-mix FLOW block's vocabulary (an earlier task — the operator: "I personally like to see
 * what are average tasks completed a day is. Average tasks created a day.").
 *
 * ── WHY THIS IS A SEPARATE, LABELLED BLOCK AND NOT ANOTHER LEGEND ROW ────────────────
 * The bar above it is a COHORT: tasks CREATED in the window, by where they stand now. Its
 * "Done" is "of the work we took on in this window, how much is finished". A
 * COMPLETED-PER-DAY rate is a different population — work that FINISHED in the window,
 * whenever it was filed. Measured on prod (project riverbend, trailing 30d, 2026-08-10):
 * cohort-Done = 262 but completions-in-window = 288, and 25 of those completions were of
 * tasks created BEFORE the window opened. Printing "9.6/day" underneath "Done 262" would
 * invite the reader to divide one by the other. So the block is separated by a rule,
 * carries its own heading, its own endpoint provenance, and a footnote naming the
 * difference in words.
 *
 * ── CANCELLED IS EXCLUDED FROM THE CREATED RATE, AND THE LABEL SAYS SO ───────────────
 * Two reasons, the second measured rather than argued:
 *   1. The created figure IS the bar's own total (`WorkMix` sums `WORK_MIX`, which omits
 *      `cancelled`). Deriving the rate from the number already on screen means the panel's
 *      two halves cannot disagree about how many tasks were created — there is only one
 *      number.
 *   2. NET/DAY IS A CLAIM ABOUT THE BACKLOG, AND THE BACKLOG CAN BE CHECKED. A cancelled
 *      task leaves the backlog without ever being completed, so counting it as an arrival
 *      while it can never appear as a departure inflates net flow. Measured on prod over
 *      the trailing 30d: open work went from ~74 to 163, i.e. the backlog really grew
 *      ~+2.97/day. Excluding cancelled gives net = (376 - 288)/30 = +2.9/day, which
 *      matches. Including cancelled gives (416 - 288)/30 = +4.3/day, which overstates the
 *      measured growth by about half, because 40 of those 416 were cancelled.
 * The `createdNote` below states the exclusion on screen; an unlabelled choice here is the
 * thing that is not defensible, not the choice itself.
 */
export const TASK_RATES = {
  /** Heading for the block; `days` is the active window. */
  heading: (days: number) => `Flow — per day over the last ${days} days`,
  /** Decimal places on a per-day rate. One: these are single-digit-to-teens rates. */
  decimals: 1,
  createdLabel: 'Created / day',
  completedLabel: 'Completed / day',
  netLabel: 'Net / day',
  openLabel: 'Open now',
  medianLabel: 'Median time to done',
  /** Direction words for the net figure — the sign alone is not a sentence. */
  netDirection: (net: number) =>
    net > 0 ? 'backlog growing' : net < 0 ? 'backlog shrinking' : 'backlog flat',
  /**
   * The footnote. This is the population trap said out loud, once, in the place the two
   * numbers sit next to each other.
   */
  footnote:
    'Completed counts work that FINISHED in this window whenever it was filed — a different set of tasks from “Done” in the bar above, which counts only tasks filed in this window.',
} as const;

/**
 * The muted tone: the "Other" roll-up bar, which is a bucket rather than a principal.
 *
 * The per-actor identity tint map that used to live here (`ACTOR_TINT` / `actorTintVar`,
 * coordinator=teal, tick=violet, operator=blue) is DELETED. Colour on this chart
 * now encodes the USER-vs-AUTOMATION group — that is the distinction the panel exists to
 * draw — and a second, contradictory meaning for the same channel is worse than no
 * meaning: `tick` painted violet inside a violet "Automated" group said nothing, while
 * `coordinator` painted teal inside a teal "User-driven" group said it twice. Actors are
 * identified by their AXIS LABEL, which was always the identifier here.
 */
export const ACTOR_MUTED_TINT = '--tx-3';

/**
 * The "Activity by actor" panel's tunables (configs-not-hardcoded).
 *
 * `metric` is a CHOICE, recorded here rather than implied by the endpoint name: the panel
 * counts CONTEXTS CREATED — work produced — not sessions started. Sessions would flatter a
 * long-lived agent that produces little, and it is the unit the coverage line must also be
 * written in, so it is named in one place that both the bars and the line read.
 */
export const ACTOR_ACTIVITY = {
  /** The metric the bars (and therefore the coverage line) are counted in. */
  metric: 'contexts',
  /** Singular/plural unit words for the coverage sentence. */
  unit: { one: 'context', many: 'contexts' },
  /** Series name shown in the chart tooltip. */
  seriesLabel: 'Contexts',
  /**
   * THE ROLL-UP RULE IS A SHARE THRESHOLD, NOT A RANK CUT (addition 2).
   *
   * A top-N cut answers "how many bars" — the wrong question. Measured in a browser at
   * `topN: 8` against prod (reports/artifacts/actor-bars-b004dad2/01-…png): the chart
   * drew FOUR sub-pixel bars (`anonymous`, `builder-a7e922bd`, `builder-76dfd903`,
   * `builder-f4707b5c`) sitting ABOVE an "Other (7 actors)" row. Four invisible bars plus
   * an Other bucket is strictly worse than a bigger Other bucket: they cost four rows of
   * height, carry no readable length, and imply the roll-up threshold is somewhere it is
   * not. The honest question is "is this bar VISIBLE", which is a question about SHARE.
   *
   * So: a bar is drawn if its count is at least `minShareOfLargest` of the largest bar IN
   * ITS OWN GROUP; everything below folds into that group's "Other". `maxBars` remains as
   * a HARD CEILING for the pathological case (hundreds of near-equal actors), not as the
   * primary rule.
   */
  minShareOfLargest: 0.02,
  /** Hard ceiling on drawn bars per group, after the share threshold has already cut. */
  maxBars: 12,
  /** Label for the roll-up bar; `n` is the number of actors folded into it. */
  otherLabel: (n: number) => `Other (${n} actor${n === 1 ? '' : 's'})`,
  /**
   * THE USER-vs-AUTOMATION GROUPS (item 3 + addition 1).
   *
   * The operator's ask, verbatim: "you can see what work was with user or user controlled and
   * what is automated." So it is TWO groups, not three: `human` and `agent` are one side
   * (an agent runs because a person dispatched it), `automation` is the other. The server
   * does the classifying — see api/domains/sessions.ts on why the registry is not mirrored
   * a third time into the browser.
   *
   * An actor the registry does not recognise is NOT a third group. It is the absence of
   * the classification and it goes to the CoverageNote, exactly as a context with no actor
   * at all already does.
   */
  groups: [
    {
      id: 'user_driven' as const,
      label: 'User-driven',
      note: 'people and the agents they dispatch',
      tintVar: '--teal',
    },
    {
      id: 'automated' as const,
      label: 'Automated',
      note: 'machinery that runs on its own schedule',
      tintVar: '--violet',
    },
  ],
  /** Px of chart height per bar — enough for an 11px tick plus separation. */
  rowHeight: 26,
  /** Px reserved for the value axis + its labels. */
  axisChrome: 30,
  /** Floor for the chart height, so a one- or two-actor window still looks like a panel. */
  minHeight: 150,
  /**
   * Category-axis gutter. Wider than the shared 72px default because a generated actor
   * slug (`builder-a7e922bd`) is 16 characters and the shared axis middle-elides rather
   * than clipping — too narrow a gutter is legible but uninformative.
   */
  categoryWidth: 124,
} as const;

/** The two drawn groups, in render order. Ids match the server's split fields. */
export type ActorGroupId = (typeof ACTOR_ACTIVITY.groups)[number]['id'];

/**
 * THE ONE kind → group rule (item 3b).
 *
 * `human` and `agent` are one side (an agent runs because a person dispatched it),
 * `automation` is the other, and an actor the registry does not recognise belongs to
 * NEITHER — `null`, which every caller must render as an absence rather than a third
 * group. Lives here, beside the group vocabulary it indexes, because two panels now ask
 * this question (the by-actor bars and the most-active-sessions rows) and two copies of a
 * classification is how the same actor ends up two colours on one screen.
 */
export function groupIdForKind(
  kind: 'human' | 'agent' | 'automation' | null | undefined,
): ActorGroupId | null {
  if (kind === 'human' || kind === 'agent') return 'user_driven';
  if (kind === 'automation') return 'automated';
  return null;
}

/**
 * The tint token for an actor's group, or the muted "not a principal" tone when the
 * registry does not know the actor. Colour on this page means USER-vs-AUTOMATION and
 * nothing else — see the ACTOR_MUTED_TINT note above on why the per-actor identity map
 * was deleted rather than reused here.
 */
export function tintVarForKind(
  kind: 'human' | 'agent' | 'automation' | null | undefined,
): string {
  const id = groupIdForKind(kind);
  return ACTOR_ACTIVITY.groups.find((g) => g.id === id)?.tintVar ?? ACTOR_MUTED_TINT;
}

/**
 * The hour-of-day rhythm panel's vocabulary (addition 4).
 *
 * The title and the series name live together, in config, for one reason: the panel's
 * previous defect was a TITLE that disagreed with what the data could support. Keeping
 * both strings in one named place makes "what does this chart claim" a single edit
 * rather than two that can drift.
 */
export const SESSION_RHYTHM = {
  /** Bucketed by session START time, in the viewer's timezone — say so in the title. */
  title: 'Sessions started — by hour',
  seriesLabel: 'Sessions',
  /**
   * ── THE CURRENT-HOUR TINT ──────────────────────────────────────────
   * The operator: "could we make the current hour bar a different color, that would separate
   * past hours from previous days hours."
   *
   * The chart folds every day in the window into 24 buckets, so nothing on it says where
   * "now" is, and the reader cannot tell which bars include today at all. One bucket is
   * marked: the hour it is right now in the viewer's own zone.
   *
   * `--amber` is the token whose documented role is "dormant, warning" — the caution hue.
   * That is the right reading here, because THIS BUCKET IS NOT LIKE THE OTHERS: every
   * other bar has had all its hours complete, and this one is still filling. Drawing a
   * partial bar identically to complete ones is the wrong-day class of defect in
   * miniature, so the colour is the flag and the legend + tooltip below are the words.
   *
   * There is deliberately NO token here for the ORDINARY bars. They keep the charting
   * module's own leading series colour (`chartTheme.series[0]`) by falling through
   * BarChartCard's `?? s.color`. Naming a default here would be a second copy of a colour
   * the chart already owns, and the two would drift.
   */
  currentHourTintVar: '--amber',
  /** The legend chip that explains the tint. A colour with no key is a mystery. */
  currentHourLegend: 'Current hour (partial)',
  /** Appended to the tooltip heading on that one bucket. */
  currentHourNote: 'current hour — partial, still filling',
} as const;
