/**
 * Read a TIME WINDOW out of a free-text search query.
 *
 * PURE: no I/O, no clock, no config reads at call time beyond the defaults a caller may
 * override. "what happened overnight on 2026-03-10 with the widget flake" → the instants
 * bounding that night, plus the query with the date/night words removed (so they are neither
 * searched for nor reported as terms the corpus lacks).
 *
 *   ISO date D alone                  → [D 00:00, D+1 00:00)
 *   D with a night word               → [(D-1) startHour:00, (D+1) endHour:00)
 *
 * All wall-clock times are in `timeZone`. No date in the query → `window: null` and the
 * query is returned untouched (behaviour identical to before this feature).
 */
import {
  SEARCH_TIME_ZONE,
  SEARCH_NIGHT_WORDS,
  SEARCH_NIGHT_START_HOUR,
  SEARCH_NIGHT_END_HOUR,
} from '../config/searchConfig.js';

export interface SearchTimeWindow {
  /** Inclusive lower bound. */
  readonly start: Date;
  /** Exclusive upper bound. */
  readonly end: Date;
}

export interface SearchTimeWindowOptions {
  readonly timeZone?: string;
  readonly nightWords?: readonly string[];
  readonly nightStartHour?: number;
  readonly nightEndHour?: number;
}

export interface ParsedSearchQuery {
  /** null when the query names no date. */
  readonly window: SearchTimeWindow | null;
  /** The query with the date token and night words removed ('' if nothing is left); === the input when window is null. */
  readonly query: string;
  /** The ISO date that was read, when one was. */
  readonly date: string | null;
  /** True when a night word widened the window. */
  readonly night: boolean;
}

const ISO_DATE_RE = /(?<![\w-])(\d{4})-(\d{2})-(\d{2})(?![\w-])/;

interface Ymd { y: number; m: number; d: number }

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Calendar arithmetic on a plain date (no zone involved). */
function addDays(p: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function zoneParts(instantMs: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** The UTC instant at which `timeZone`'s wall clock reads y-m-d hour:00. DST-safe (fixed-point). */
export function zonedWallClockToInstant(p: Ymd, hour: number, timeZone: string): Date {
  const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, hour, 0, 0);
  let guess = wallAsUtc;
  for (let i = 0; i < 3; i++) {
    const z = zoneParts(guess, timeZone);
    const shown = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s);
    const next = guess + (wallAsUtc - shown);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** The calendar date (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function isoDateInZone(instant: Date | string | number, timeZone: string = SEARCH_TIME_ZONE): string {
  const z = zoneParts(new Date(instant).getTime(), timeZone);
  return `${String(z.y).padStart(4, '0')}-${String(z.m).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
}

/** Does `instant` fall inside `window` ([start, end))? Null/garbage dates are outside. */
export function windowContains(window: SearchTimeWindow, instant: Date | string | null | undefined): boolean {
  if (instant === null || instant === undefined) return false;
  const t = new Date(instant).getTime();
  return Number.isFinite(t) && t >= window.start.getTime() && t < window.end.getTime();
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parseSearchTimeWindow(query: string, opts: SearchTimeWindowOptions = {}): ParsedSearchQuery {
  const none: ParsedSearchQuery = { window: null, query, date: null, night: false };
  const timeZone = opts.timeZone ?? SEARCH_TIME_ZONE;
  const nightWords = opts.nightWords ?? SEARCH_NIGHT_WORDS;
  const startHour = opts.nightStartHour ?? SEARCH_NIGHT_START_HOUR;
  const endHour = opts.nightEndHour ?? SEARCH_NIGHT_END_HOUR;

  const m = ISO_DATE_RE.exec(query);
  if (!m) return none;
  const day: Ymd = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (!validYmd(day.y, day.m, day.d)) return none;

  // Night words, longest phrase first so "last night" is consumed whole, not as "night".
  const words = [...nightWords].filter((w) => w.trim() !== '').sort((a, b) => b.length - a.length);
  let rest = query.slice(0, m.index) + ' ' + query.slice(m.index + m[0].length);
  let night = false;
  if (words.length > 0) {
    const re = new RegExp(`(?<![\\w])(?:${words.map(escapeRe).join('|')})(?![\\w])`, 'gi');
    rest = rest.replace(re, () => { night = true; return ' '; });
  }
  const stripped = rest.replace(/\s+/g, ' ').trim();

  const window: SearchTimeWindow = night
    ? {
        start: zonedWallClockToInstant(addDays(day, -1), startHour, timeZone),
        end: zonedWallClockToInstant(addDays(day, 1), endHour, timeZone),
      }
    : {
        start: zonedWallClockToInstant(day, 0, timeZone),
        end: zonedWallClockToInstant(addDays(day, 1), 0, timeZone),
      };
  // `query` may be '' (a query that was only a date). The caller decides what to search with
  // then; this parser only reports what is left once the window words are gone.
  return { window, query: stripped, date: m[0], night };
}
