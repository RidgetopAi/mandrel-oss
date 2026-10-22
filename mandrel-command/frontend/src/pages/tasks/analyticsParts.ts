/**
 * Analytics-view pure helpers — the data derivations behind the Tasks · Analytics panels.
 * Pure + unit-friendly, NO data access and NO colour literals here: `toneHex` resolves a
 * semantic tone to a chart-theme field (token-sourced), and the derive* functions turn the
 * loaded task rows / stats into the fixed-order categorical series each panel plots.
 *
 * DATA HONESTY: these only ever count REAL rows. "Open by priority" +
 * "Oldest open" are derived from the same loaded task set the board uses (bounded by
 * TASKS_CONFIG.listLimit — the backend now honours that limit) — never fabricated, never
 * padded. The time-based series (per-day throughput, completed-by-actor) have NO derivation
 * here on purpose: they need window-accurate, completion-dated aggregation the loaded rows
 * can't provide, so their panels read dedicated server endpoints instead (see hooks.ts).
 */
import type { ChartTheme } from '../../components/charts';
import type { Task, TaskStatus } from '../../types/task';
import {
  ANALYTICS_CONFIG,
  ANALYTICS_PRIORITY_SERIES,
  OPEN_STATUSES,
  type AnalyticsTone,
} from './config';

/** Resolve a semantic tone to a concrete hex from the active chart theme (no literals). */
export function toneHex(ct: ChartTheme, tone: AnalyticsTone): string {
  switch (tone) {
    case 'teal':
      return ct.accent;
    case 'ok':
      return ct.status.ok;
    case 'warn':
      return ct.status.warn;
    case 'crit':
      return ct.status.crit;
    case 'blue':
      return ct.series[2];
    case 'violet':
      return ct.series[1];
    case 'muted':
    default:
      return ct.textFaint;
  }
}

/** Is a task open (not completed / cancelled)? */
export function isOpen(task: Task): boolean {
  return (OPEN_STATUSES as ReadonlyArray<TaskStatus>).includes(task.status);
}

/**
 * Open tasks grouped into the fixed priority order (urgent/high/medium/low), each with
 * its resolved bar colour. Derived from the loaded rows (open only) — real counts.
 */
export function deriveOpenByPriority(
  rows: Task[],
  ct: ChartTheme,
): Array<{ key: string; label: string; count: number; color: string }> {
  const counts = new Map<string, number>();
  for (const t of rows) {
    if (!isOpen(t)) continue;
    const p = (t.priority ?? 'low').toString();
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return ANALYTICS_PRIORITY_SERIES.map((s) => ({
    key: s.key,
    label: s.label,
    count: counts.get(s.key) ?? 0,
    color: toneHex(ct, s.tone),
  }));
}

/**
 * Status counts for the "open by status" stacked bar + key. Reads the REAL, uncapped
 * `by_status` stats map (not the loaded rows) so the counts are workspace-accurate.
 * Missing statuses read 0.
 */
export function statusCount(byStatus: Record<string, number> | undefined, key: TaskStatus): number {
  return byStatus?.[key] ?? 0;
}

/** Age of a task in whole days from its created_at (0 if unparseable). */
export function ageDays(createdAt: string | undefined | null, now: number = Date.now()): number {
  if (!createdAt) return 0;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** The aging heat bucket for an age in days (config thresholds). */
export function ageHeat(days: number): 'hot' | 'warm' | 'cool' {
  if (days >= ANALYTICS_CONFIG.agingHotDays) return 'hot';
  if (days >= ANALYTICS_CONFIG.agingWarmDays) return 'warm';
  return 'cool';
}

export interface AgingRow {
  id: string;
  title: string;
  priority: string;
  days: number;
  heat: 'hot' | 'warm' | 'cool';
}

/**
 * The oldest OPEN tasks (by created_at ascending), capped for the DOM. Derived from the
 * loaded task set the board shows — real rows, real ages. (A dedicated "oldest open"
 * endpoint would remove the list cap; that's a backend addition, out of scope here.)
 */
export function deriveAging(rows: Task[], now: number = Date.now()): AgingRow[] {
  return rows
    .filter(isOpen)
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.created_at ?? '') || 0;
      const tb = Date.parse(b.created_at ?? '') || 0;
      return ta - tb; // oldest first
    })
    .slice(0, ANALYTICS_CONFIG.agingListCap)
    .map((t) => {
      const days = ageDays(t.created_at, now);
      return {
        id: t.id,
        title: t.title ?? '(untitled task)',
        priority: (t.priority ?? 'low').toString(),
        days,
        heat: ageHeat(days),
      };
    });
}
