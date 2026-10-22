/**
 * Calendar date math — pure, dependency-free, local-time helpers so the week grid
 * is deterministic and unit-testable (no date-fns/dayjs pulled in here). Everything
 * works on LOCAL calendar days (what the user sees as "today"), and the day key is
 * a `YYYY-MM-DD` string so trend/tasks rows bucket by the same key regardless of
 * whether the API returns a date or a full ISO timestamp.
 */

/** Fixed, locale-independent labels (tests must not depend on the host locale). */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;
export const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
export const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Number of week-rows a month grid always renders (6 → covers every month layout). */
export const MONTH_GRID_ROWS = 6;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight (local) of the given date — strips the time-of-day. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Add `n` whole days (local), returning a new Date at the same wall-clock time. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

/** Add `n` weeks. */
export function addWeeks(d: Date, n: number): Date {
  return addDays(d, n * 7);
}

/** Midnight (local) of the first day of `d`'s month. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Add `n` calendar months, clamping the day-of-month to the target month's length
 * (Jan 31 + 1mo → Feb 28/29, never overflowing into March). Returns local midnight.
 */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}

/**
 * The midnight of the week containing `d`, anchored to `weekStartsOn`
 * (0 = Sunday … 6 = Saturday).
 */
export function startOfWeek(d: Date, weekStartsOn: number): Date {
  const base = startOfDay(d);
  const shift = (base.getDay() - weekStartsOn + 7) % 7;
  return addDays(base, -shift);
}

/** The 7 local day-midnights of the week beginning at `weekStart`. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * The 42 local day-midnights (6 rows × 7 cols) of the month grid containing
 * `anchor` — leading days spill from the previous month and trailing days into the
 * next so every row is full. Grid row 0 starts on the `weekStartsOn` weekday.
 */
export function monthGridDays(anchor: Date, weekStartsOn: number): Date[] {
  const gridStart = startOfWeek(startOfMonth(anchor), weekStartsOn);
  return Array.from({ length: MONTH_GRID_ROWS * 7 }, (_, i) => addDays(gridStart, i));
}

/** True when `a` and `b` fall in the same calendar month + year. */
export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** `YYYY-MM-DD` local-calendar key (stable bucket key for trends/tasks). */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Normalise an API date/timestamp to a `YYYY-MM-DD` key. Accepts a date-only
 * bucket (`2026-07-13`) or a full ISO timestamp (`2026-07-13T09:12:00Z`); returns
 * '' for anything unparseable so callers can skip it.
 */
export function apiDateKey(s: string | null | undefined): string {
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : '';
}

/** Whole-day span from `a` to `b` (b - a), both floored to local midnight. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / MS_PER_DAY);
}

export function isSameDay(a: Date, b: Date): boolean {
  return toDateKey(a) === toDateKey(b);
}

/** Relative day position vs `now` (defaults to the real clock). */
export function dayPosition(d: Date, now: Date = new Date()): 'past' | 'today' | 'future' {
  const delta = daysBetween(now, d);
  if (delta < 0) return 'past';
  if (delta === 0) return 'today';
  return 'future';
}

/**
 * "Jul 11 – 17, 2026" (same month) or "Jun 29 – Jul 5, 2026" (crossing months) or
 * "Dec 28, 2025 – Jan 3, 2026" (crossing years). Locale-independent.
 */
export function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const sM = MONTH_SHORT[weekStart.getMonth()];
  const eM = MONTH_SHORT[end.getMonth()];
  const sD = weekStart.getDate();
  const eD = end.getDate();
  const sY = weekStart.getFullYear();
  const eY = end.getFullYear();
  if (sY !== eY) return `${sM} ${sD}, ${sY} – ${eM} ${eD}, ${eY}`;
  if (weekStart.getMonth() !== end.getMonth()) return `${sM} ${sD} – ${eM} ${eD}, ${eY}`;
  return `${sM} ${sD} – ${eD}, ${eY}`;
}

/** Short weekday label ("Mon"). */
export function weekdayShort(d: Date): string {
  return WEEKDAY_SHORT[d.getDay()];
}

/** "July 2026" — the Month-view range label. Locale-independent. */
export function formatMonthLabel(d: Date): string {
  return `${MONTH_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Wednesday, Jul 16, 2026" — the Day-view range label. Locale-independent. */
export function formatDayLabel(d: Date): string {
  return `${WEEKDAY_LONG[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Parse a `YYYY-MM-DD` key (e.g. the value of a native date input) to a LOCAL
 * midnight Date, or null when it isn't a valid calendar day. The inverse of
 * `toDateKey` — used by the jump-to-date affordance.
 */
export function parseDateKey(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(y, mo, day);
  // Reject overflow (e.g. 2026-02-31 → Mar 3): round-trip must match the input.
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
  return d;
}
