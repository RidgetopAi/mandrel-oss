/**
 * DaySummary — the click-into-a-day REPORT CARD.
 *
 * The calendar shell renders `<DaySummary date tz project scope onClose/>` the moment a day
 * cell is clicked; this component owns WHAT renders. It fetches GET /api/day-summary
 * for the clicked LOCAL day (formatted from local date parts — never a UTC-shifted
 * toISOString, which would move an evening record to the next day) and renders the
 * approved mock (docs/command-day-summary-mock.html): header + auto-headline, the
 * transparent Momentum ring, KPI tiles with baseline deltas, a 24h activity ribbon,
 * "what got done" highlight cards, decisions, the completed-task checklist, and the
 * by-actor bars. Every Mandrel id is a clickable `/r/<id8>` resolve-link.
 *
 * Presentation: a full-screen modal overlay (portal → body) so the wide report reads
 * well regardless of where the shell mounts it. The `.card` node is the exact target
 * of the dependency-free PNG export (utils/domToPng); the Export/Copy actions carry
 * `data-export-exclude` so they never appear in the shareable artifact.
 *
 * States: loading (spinner), error (honest Alert), and a real low-activity/quiet-day
 * state (NOT a stub, NOT an error) when a day recorded little/nothing.
 */
import React from 'react';
import type { AxiosRequestConfig } from 'axios';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Spinner, Alert, useFocusTrap, useScrollLock } from '../../components/ui';
import { api } from '../../api';
import type { DaySummaryData, DaySummaryKpi } from '../../api/domains/daySummary';
import { buildNavHref } from '../../utils/navIdLinkify';
import { id8 } from '../projects/parts';
import { downloadNodeAsPng } from '../../utils/domToPng';
import { toDateKey, WEEKDAY_SHORT, MONTH_SHORT } from './dates';
import { useProjectContext } from '../../contexts/ProjectContext';
import { DAY_SUMMARY_UI } from './daySummaryConfig';
import styles from './DaySummary.module.css';
import { apiErrorMessage } from '../../api/request';

export interface DaySummaryProps {
  /** The local calendar day that was clicked. */
  date: Date;
  /** Viewer IANA timezone (e.g. "America/New_York"); undefined → backend defaults to UTC. */
  tz: string | undefined;
  /**
   * The Calendar's project selection, INHERITED — this card has no selector of its own by
   * design (an earlier epic §E). Passed to the endpoint RAW, the literal `'all'` included:
   * the backend reads `'all'` on a query source as explicitly unscoped, which is a
   * different request from omitting the param.
   */
  project: string;
  /**
   * The Calendar page's per-request scope (`usePageProject().scope`), so the card and the
   * grid behind it cannot disagree about which project they are showing. Required: the
   * alternative is inheriting the ambient default project, which after this change set is
   * NOT necessarily what the calendar displays.
   */
  scope: () => AxiosRequestConfig;
  /** Dismiss the card (shell clears `selectedDate`). Optional so the card can omit it. */
  onClose?: () => void;
}

const ACTOR_COLORS = [
  'var(--teal)',
  'var(--blue)',
  'var(--amber)',
  'var(--violet)',
  'var(--green)',
  'var(--rose)',
];

/** A clickable `/r/<id8>` resolve-link (reuses the app-wide id-link convention). */
const RecordLink: React.FC<{ id: string; className?: string }> = ({ id, className }) => (
  <Link className={className ?? styles.lnk} to={buildNavHref(id)}>
    r/{id8(id)}
  </Link>
);

/** Signed delta pill: ▲/▼ vs the rolling baseline, or "= avg" when on par. */
function deltaView(delta: number, hours = false): { cls: string; text: string } {
  const num = hours ? delta / 60 : delta;
  const abs = Math.abs(num);
  const str = hours ? `${abs.toFixed(1)}h` : String(Math.round(abs));
  if (num > 0) return { cls: styles.up, text: `▲ ${str}` };
  if (num < 0) return { cls: styles.dn, text: `▼ ${str}` };
  return { cls: styles.flat, text: '= avg' };
}

const KpiTile: React.FC<{ label: string; kpi: DaySummaryKpi; hours?: boolean }> = ({
  label,
  kpi,
  hours = false,
}) => {
  const d = deltaView(kpi.delta, hours);
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiK}>{label}</div>
      <div className={styles.kpiV}>
        {hours ? (
          <>
            {(kpi.value / 60).toFixed(1)}
            <span className={styles.kpiUnit}>h</span>
          </>
        ) : (
          kpi.value.toLocaleString()
        )}
      </div>
      <div className={`${styles.kpiD} ${d.cls}`}>{d.text}</div>
    </div>
  );
};

/** The Momentum ring — a 0-100 arc + the delta vs the user's own baseline. */
const MomentumRing: React.FC<{ score: number; delta: number }> = ({ score, delta }) => {
  const { size, radius, stroke } = DAY_SUMMARY_UI.ring;
  const clamped = Math.max(0, Math.min(100, score));
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - clamped / 100);
  const c = size / 2;
  const d = deltaView(delta);
  return (
    <div className={styles.ring}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Momentum ${clamped} of 100`}
      >
        <circle cx={c} cy={c} r={radius} fill="none" stroke="var(--s2)" strokeWidth={stroke} />
        <circle
          cx={c}
          cy={c}
          r={radius}
          fill="none"
          stroke="var(--teal)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${c} ${c})`}
        />
        <text x={c} y={c - 2} textAnchor="middle" className={styles.ringVal}>
          {clamped}
        </text>
        <text x={c} y={c + 13} textAnchor="middle" className={styles.ringSub}>
          MOMENTUM
        </text>
      </svg>
      <div className={`${styles.ringDelta} ${d.cls}`}>{d.text} vs baseline</div>
    </div>
  );
};

function tagClass(type: string): string {
  return type === 'milestone' ? styles.tagMilestone : styles.tagCompletion;
}

/** Overlay chrome shared by every state (loading / error / quiet / full card). */
const Overlay: React.FC<{ label: string; onClose?: () => void; children: React.ReactNode }> = ({
  label,
  onClose,
  children,
}) => {
  const shellRef = React.useRef<HTMLDivElement>(null);
  useScrollLock(true);
  useFocusTrap(true, shellRef, { onEscape: onClose });

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className={styles.shell} ref={shellRef} onMouseDown={(e) => e.stopPropagation()}>
        {onClose && (
          <button
            type="button"
            className={styles.close}
            data-export-exclude="true"
            onClick={onClose}
            aria-label="Close day summary"
          >
            ×
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
};

export const DaySummary: React.FC<DaySummaryProps> = ({ date, tz, project, scope, onClose }) => {
  const dateKey = toDateKey(date); // LOCAL yyyy-mm-dd — no UTC shift.
  const headerDate = `${WEEKDAY_SHORT[date.getDay()]} ${MONTH_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  const ariaLabel = `Day summary for ${headerDate}`;

  const cardRef = React.useRef<HTMLDivElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  // The ONE central project list (contexts/ProjectContext) — the same source the
  // Calendar's selector reads, rather than a second `/api/projects` fetch for one label.
  const { allProjects } = useProjectContext();
  const { data, isLoading, isError, error } = useQuery<DaySummaryData>({
    queryKey: ['calendar', 'daySummary', dateKey, project, tz ?? null],
    queryFn: () => api.daySummary.get({ date: dateKey, project, tz }, scope()),
    staleTime: DAY_SUMMARY_UI.staleTimeMs,
  });

  const handleExport = React.useCallback(async () => {
    if (!cardRef.current) return;
    setBusy(true);
    setToast(null);
    try {
      await downloadNodeAsPng(cardRef.current, `${DAY_SUMMARY_UI.png.filePrefix}-${dateKey}.png`, {
        scale: DAY_SUMMARY_UI.png.scale,
        background: DAY_SUMMARY_UI.png.background,
        filter: (el) => el.getAttribute('data-export-exclude') !== 'true',
      });
      setToast('PNG downloaded');
    } catch {
      setToast('Export failed — try again');
    } finally {
      setBusy(false);
    }
  }, [dateKey]);

  const handleCopyLink = React.useCallback(async () => {
    const url = typeof window !== 'undefined' ? window.location.href : DAY_SUMMARY_UI.shareBase;
    try {
      await navigator.clipboard.writeText(url);
      setToast('Link copied');
    } catch {
      setToast('Copy failed');
    }
  }, []);

  if (isLoading) {
    return (
      <Overlay label={ariaLabel} onClose={onClose}>
        <div className={styles.stateWrap}>
          <Spinner size="lg" />
        </div>
      </Overlay>
    );
  }

  if (isError || !data) {
    return (
      <Overlay label={ariaLabel} onClose={onClose}>
        <div className={styles.stateWrap}>
          <Alert variant="error" title="Couldn't load this day">
            {apiErrorMessage(error, 'Failed to load the day summary.')}
          </Alert>
        </div>
      </Overlay>
    );
  }

  const scopeLabel =
    project === 'all'
      ? 'all projects'
      : allProjects.find((p) => p.id === project)?.name ?? `project ${id8(project)}`;

  const activeHours = (data.kpis.activeMinutes.value / 60).toFixed(1);
  // The card's human sub-header. Named `scopeSummary`, not `scope`, because `scope` is now
  // the REQUEST scope this component is handed — two different things one letter apart.
  const scopeSummary = `${scopeLabel} · ${data.kpis.sessions.value} session${data.kpis.sessions.value === 1 ? '' : 's'} · ${activeHours}h active`;

  const ribbonMax = Math.max(1, ...data.ribbon.map((r) => r.count));
  const milestones = data.highlights.filter((h) => h.type === 'milestone').length;
  const completions = data.highlights.length - milestones;
  const highlights = data.highlights.slice(0, DAY_SUMMARY_UI.maxHighlights);
  const shownTasks = data.tasksCompleted.items.slice(0, DAY_SUMMARY_UI.maxTasksShown);
  const moreTasks = data.tasksCompleted.count - shownTasks.length;
  const actorMax = Math.max(1, ...data.byActor.map((a) => a.count));

  const activityTotal =
    data.kpis.sessions.value +
    data.kpis.contexts.value +
    data.kpis.decisions.value +
    data.kpis.tasksDone.value +
    data.highlights.length +
    data.decisions.length +
    data.tasksCompleted.count +
    data.ribbon.reduce((s, r) => s + r.count, 0);
  const isQuiet = activityTotal === 0;

  const generatedLabel = `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}`;

  return (
    <Overlay label={ariaLabel} onClose={onClose}>
      <div className={styles.card} ref={cardRef}>
        <div className={styles.cardInner}>
          {/* HEADER */}
          <div className={styles.hdr}>
            <div className={styles.hdrL}>
              <div className={styles.kick}>Day Summary</div>
              <div className={styles.date}>
                {WEEKDAY_SHORT[date.getDay()]}{' '}
                <b>
                  {MONTH_SHORT[date.getMonth()]} {date.getDate()}
                </b>
                , {date.getFullYear()}
              </div>
              <div className={styles.scope}>{scopeSummary}</div>
              {data.headline && (
                <div className={styles.headline}>
                  <span className={styles.quote}>“</span>
                  {data.headline}
                  <span className={styles.quote}>”</span>
                </div>
              )}
            </div>
            <MomentumRing score={data.momentum.score} delta={data.momentum.delta} />
          </div>

          {/* KPI ROW */}
          <div className={styles.kpis}>
            <KpiTile label="Sessions" kpi={data.kpis.sessions} />
            <KpiTile label="Active" kpi={data.kpis.activeMinutes} hours />
            <KpiTile label="Contexts" kpi={data.kpis.contexts} />
            <KpiTile label="Decisions" kpi={data.kpis.decisions} />
            <KpiTile label="Tasks done" kpi={data.kpis.tasksDone} />
            <KpiTile label="Files" kpi={data.kpis.filesTouched} />
          </div>

          {isQuiet ? (
            <div className={styles.quiet}>
              <div className={styles.quietTitle}>A quiet day</div>
              <div className={styles.quietSub}>
                No sessions, contexts, decisions or completed tasks were recorded for {scopeLabel} on
                this day.
              </div>
            </div>
          ) : (
            <>
              {/* ACTIVITY RIBBON */}
              <div className={styles.sec}>
                <div className={styles.secH}>
                  Activity — when the work happened
                  <span className={styles.secRule} />
                </div>
                <div className={styles.ribbon}>
                  {data.ribbon.map((r) => {
                    const frac = r.count / ribbonMax;
                    const pct =
                      r.count === 0 ? 0 : Math.max(DAY_SUMMARY_UI.ribbon.minBarPct, frac * 100);
                    const cls =
                      frac >= DAY_SUMMARY_UI.ribbon.hotFraction
                        ? styles.barHot
                        : frac >= DAY_SUMMARY_UI.ribbon.warmFraction
                          ? styles.barWarm
                          : '';
                    return (
                      <div
                        key={r.hour}
                        className={`${styles.bar} ${cls}`}
                        style={{ height: `${pct}%` }}
                        title={`${r.hour}:00 — ${r.count} events`}
                      />
                    );
                  })}
                </div>
                <div className={styles.ribbonAx}>
                  <span>12a</span>
                  <span>6a</span>
                  <span>12p</span>
                  <span>6p</span>
                  <span>12a</span>
                </div>
              </div>

              {/* WHAT GOT DONE */}
              {highlights.length > 0 && (
                <div className={styles.sec}>
                  <div className={styles.secH}>
                    What got done
                    <span className={styles.secCnt}>
                      · {milestones} milestone{milestones === 1 ? '' : 's'} · {completions} completion
                      {completions === 1 ? '' : 's'}
                    </span>
                    <span className={styles.secRule} />
                  </div>
                  <div className={styles.hl}>
                    {highlights.map((h) => (
                      <div key={h.id} className={styles.hlItem}>
                        <span className={`${styles.tag} ${tagClass(h.type)}`}>{h.type}</span>
                        <div>
                          <div className={styles.hlTxt}>{h.text}</div>
                          <div className={styles.hlId}>
                            <RecordLink id={h.id} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* DECISIONS + TASKS */}
              <div className={`${styles.sec} ${styles.two}`}>
                <div>
                  <div className={styles.secH}>
                    Decisions <span className={styles.secCnt}>· {data.decisions.length}</span>
                    <span className={styles.secRule} />
                  </div>
                  {data.decisions.length === 0 ? (
                    <div className={styles.meta}>No decisions recorded.</div>
                  ) : (
                    <div className={styles.list}>
                      {data.decisions.map((dec) => (
                        <div key={dec.id} className={styles.row}>
                          <span className={styles.dot} />
                          <div className={styles.rowBody}>
                            {dec.title} <RecordLink id={dec.id} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className={styles.secH}>
                    Tasks completed{' '}
                    <span className={styles.secCnt}>· {data.tasksCompleted.count}</span>
                    <span className={styles.secRule} />
                  </div>
                  {data.tasksCompleted.count === 0 ? (
                    <div className={styles.meta}>No tasks completed.</div>
                  ) : (
                    <div className={styles.list}>
                      {shownTasks.map((t) => (
                        <div key={t.id} className={styles.row}>
                          <span className={styles.chk}>✓</span>
                          <div className={styles.rowBody}>
                            {t.title} <RecordLink id={t.id} />
                          </div>
                        </div>
                      ))}
                      {moreTasks > 0 && (
                        <div className={styles.row}>
                          <span className={`${styles.chk} ${styles.chkMore}`}>＋</span>
                          <div className={`${styles.rowBody} ${styles.meta}`}>{moreTasks} more…</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* BY ACTOR */}
              {data.byActor.length > 0 && (
                <div className={styles.sec}>
                  <div className={styles.secH}>
                    By actor — who did the work
                    <span className={styles.secRule} />
                  </div>
                  <div className={styles.actors}>
                    {data.byActor.map((a, i) => (
                      <div key={a.actor} className={styles.actor}>
                        <span className={styles.actorNm}>{a.actor}</span>
                        <div className={styles.track}>
                          <div
                            className={styles.fill}
                            style={{
                              width: `${Math.max(6, (a.count / actorMax) * 100)}%`,
                              background: ACTOR_COLORS[i % ACTOR_COLORS.length],
                            }}
                          />
                        </div>
                        <span className={styles.actorN}>{a.count}×</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* FOOTER — watermark stays in the export; the actions are excluded. */}
        <div className={styles.foot}>
          <div className={styles.wm}>
            {/*
              The host is THIS instance's own (daySummaryConfig.watermarkHost, derived
              from window.location) — never a literal. This artifact is a PNG a user
              posts publicly; a baked-in hostname watermarks every tenant's export with
              OUR Command UI. Renders without the host segment when the origin is
              unknown rather than falling back to anyone's domain.
            */}
            <b>Mandrel</b>
            {DAY_SUMMARY_UI.watermarkHost ? ` · ${DAY_SUMMARY_UI.watermarkHost}` : ''} · generated{' '}
            {generatedLabel}
          </div>
          {toast && (
            <span className={styles.toast} data-export-exclude="true">
              {toast}
            </span>
          )}
          <div className={styles.actions} data-export-exclude="true">
            <button type="button" className={styles.btn} onClick={handleCopyLink}>
              Copy link
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleExport}
              disabled={busy}
            >
              {busy ? 'Rendering…' : '⤓ Export PNG'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
};

export default DaySummary;
