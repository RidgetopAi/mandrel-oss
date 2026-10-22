/**
 * SessionRhythm — the 24-bucket hour-of-day histogram. BUILT endpoint
 * `/api/sessions/token-patterns` (24 gap-filled hour rows, now windowed and bucketed in
 * the viewer's timezone). REUSES the shared `BarChartCard` — no new chart component.
 * Owns loading (BarChartCard) / empty / error state.
 *
 * ── WHY THIS IS NO LONGER "TOKEN RHYTHM" (item 2 + addition 4) ────────
 * The endpoint buckets a session by the hour it STARTED. Attributing that session's WHOLE
 * token figure to that one hour was only tolerable while nobody looked at the number:
 * mean session length on prod is 10.3 hours, so a session that began at 01:00 and ran
 * until noon put every token it ever spent into the 1am bar. The chart said the operator works
 * at 1am. He does not; he STARTS at 1am, once, and then works all day.
 *
 * Fixing the timezone alone (the other half of item 2) would have made that claim
 * PRECISELY wrong rather than vaguely wrong, which is the worse outcome — a plausible
 * chart is the one people act on. So the token framing is RETIRED and the panel is drawn
 * in the unit the data actually supports: SESSIONS STARTED per hour, which is exactly
 * what a start-time histogram measures and is genuinely useful (it is the working-rhythm
 * question the panel was reaching for).
 *
 * The token figure is still in the payload and still true of those sessions, so the
 * tooltip carries it as a secondary series. Attributing tokens to the hours a session
 * actually SPANNED needs a per-call token ledger that does not exist yet (the task's
 * out-of-scope item 5) — it is a different query, not a different label.
 *
 * ── THE CURRENT HOUR IS MARKED ───────────────────────────────────────
 * The operator: "it's a little odd in how it's presented… could we make the current hour bar a
 * different color, that would separate past hours from previous days hours." Folding N
 * days into 24 buckets leaves the chart with no anchor for "now", so one bucket is tinted,
 * keyed in the caption, and annotated in its tooltip.
 *
 * The hour is read in THE ZONE THE REQUEST WAS BUCKETED IN, not in a second notion of now.
 * `getBrowserTimeZone()` is the single source that `api.sessions.tokenPatterns` sends as
 * `?tz=`, and `currentHourInZone` reads the clock through that same value — including its
 * `undefined` case, where the backend documents that it falls back to UTC and so does
 * this. That third state is the one worth being careful about: taking the local hour while
 * the server bucketed in UTC would confidently tint a bar that is up to 12 buckets away
 * from the truth, which is worse than not marking one at all.
 */
import React from 'react';
import { BarChartCard, useChartTheme } from '../../components/charts';
import { Panel, Provenance } from './parts';
import { PulseIcon } from './icons';
import { tintHex } from './ActorBars';
import { SESSION_RHYTHM } from './config';
import type { TokenUsagePattern } from '../../api/domains/sessions';
import { getBrowserTimeZone } from '../../utils/browserTimeZone';
import styles from './Analytics.module.css';
import { apiErrorMessage } from '../../api/request';

export interface SessionRhythmProps {
  patterns: TokenUsagePattern[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

/** `0 -> 12a`, `13 -> 1p`. Exported so the labelling is provable without a DOM. */
export function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/**
 * The hour (0–23) it is right now IN THE ZONE THE SERVER BUCKETED WITH.
 *
 * `tz` is `getBrowserTimeZone()`'s value verbatim — the SAME expression the request sends
 * — so the mark and the buckets can never be computed against different clocks. An
 * `undefined` tz is not a failure to handle later: it is exactly the case where the client
 * could not report a zone and the backend therefore bucketed in UTC, so UTC is the honest
 * reading here too, and it is passed explicitly rather than left to `Intl`'s local default.
 *
 * `hour12: false` can format midnight as `24` in some ICU builds, hence the `% 24`.
 * Exported, with `now` injectable, so both the value and the discriminator (a NON-current
 * hour must not be marked) are provable without a DOM or a fake system clock.
 */
export function currentHourInZone(tz: string | undefined, now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: tz ?? 'UTC',
  }).format(now);
  return Number(hour) % 24;
}

/** One chart row. `color` is present on the CURRENT hour only — see `rhythmRows`. */
export type RhythmRow = Record<string, number | string>;

/**
 * Build the chart rows, marking exactly one bucket.
 *
 * ONLY the current bucket carries a `color`. Every other row omits the key entirely, and
 * BarChartCard's `fill={(row[colorKey]) ?? s.color}` falls those through to the charting
 * module's own leading series colour. That omission is deliberate: naming a default token
 * here would be a second copy of a colour the chart already owns, and the two would drift
 * the first time the palette moved.
 *
 * Pure and exported so the discriminator that matters — a NON-current hour must not be
 * tinted — is provable by inspecting the rows, with no DOM and no clock.
 */
export function rhythmRows(
  patterns: TokenUsagePattern[] | undefined,
  currentLabel: string,
  currentTint: string,
): RhythmRow[] {
  return (patterns ?? []).map((p) => {
    const label = hourLabel(p.hour);
    const row: RhythmRow = { hour: label, sessions: Number(p.session_count ?? 0) };
    if (label === currentLabel) row.color = currentTint;
    return row;
  });
}

export const SessionRhythm: React.FC<SessionRhythmProps> = ({
  patterns,
  isLoading,
  isError,
  error,
}) => {
  // recharts sets `fill` as an SVG PRESENTATION ATTRIBUTE, where `var(--amber)` does not
  // resolve — so the token name is the source and `tintHex` is the one resolution step
  // (the same one ActorBars uses; a second copy is how one page ends up two palettes).
  const ct = useChartTheme();

  if (isError) {
    return (
      <Panel
        icon={<PulseIcon size={15} />}
        title={SESSION_RHYTHM.title}
        provenance={<Provenance>/api/sessions/token-patterns</Provenance>}
      >
        <div className={styles.inlineError} role="alert">
          {apiErrorMessage(error, "Couldn't load the session rhythm.")}
        </div>
      </Panel>
    );
  }

  const currentLabel = hourLabel(currentHourInZone(getBrowserTimeZone()));
  const data = rhythmRows(
    patterns,
    currentLabel,
    tintHex(ct.theme, SESSION_RHYTHM.currentHourTintVar),
  );

  /*
    The chart's caption row: the key that explains the tint, beside the endpoint line the
    panel already printed. Hoisted out of the JSX prop rather than written inline because
    `dateAxis.test.tsx` scans every `<BarChartCard>` OPENING TAG and requires it to contain
    no self-closing element — an inline `<span … />` in a prop makes an element's own tag
    text look like it has run past its end, which is the bleed that scanner exists to
    catch. Keeping the markup out here satisfies it without softening it.
  */
  const caption = (
    <span className={styles.rhythmCap}>
      <span className={styles.rhythmKey}>
        <span
          className={styles.rhythmKeyDot}
          style={{ background: `var(${SESSION_RHYTHM.currentHourTintVar})` }}
          aria-hidden="true"
        />
        {SESSION_RHYTHM.currentHourLegend}
      </span>
      <Provenance>/api/sessions/token-patterns</Provenance>
    </span>
  );

  return (
    <BarChartCard
      data={data}
      xKey="hour" /* non-date-axis: hour-of-day buckets (0-23), not a calendar day */
      series={[{ key: 'sessions', name: SESSION_RHYTHM.seriesLabel }]}
      colorKey="color"
      /*
        The axis tick is ~2 characters wide, so the caveat cannot live there. The tooltip
        is where the reader lands when they ask about the odd-coloured bar, and what they
        need to be told is that this bucket is NOT comparable to its neighbours: every
        other bar counts whole elapsed hours, this one is still filling.
      */
      tooltipLabelFormatter={(label) =>
        label === currentLabel ? `${currentLabel} · ${SESSION_RHYTHM.currentHourNote}` : String(label)
      }
      title={SESSION_RHYTHM.title}
      caption={caption}
      height={150}
      loading={isLoading}
      empty={data.length === 0}
    />
  );
};

export default SessionRhythm;
