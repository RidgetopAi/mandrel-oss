/**
 * StreamCard — one session rendered as the mock's accordion "stream" card. The
 * header always shows project · title · status · headline metrics · last-seen; the
 * body lazy-loads the full session detail (only when expanded) and renders the stat
 * row + the recent-first activity timeline (contexts/decisions/tasks/commits merged).
 *
 * The actor chip (the "who") now renders from the serialised `actor`
 * — null actors get the neutral "unattributed" treatment.
 * STILL OMITTED vs the mock (no backend source — surfaced, never faked): the
 * per-actor×project stream-keying, the per-hour sparkline strip, the per-card
 * decision count, and the "Walk thread" / "Pin" graph actions. The read model does
 * not serialise per-session decision counts on the LIST; decisions ARE available on
 * the detail (shown in the expanded stat row).
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  StatusPill,
  StatTile,
  Button,
  Modal,
  Spinner,
  Alert,
  Text,
  Code,
  cx,
} from '../../components/ui';
import { projectDotVar, KIND_TONE, SESSIONS_CONFIG, actorLabel, type SessionStatus } from './config';
import {
  SectionHead,
  ActorChip,
  formatCount,
  formatTokens,
  formatRelative,
  lastSeen,
  buildTimeline,
  TimelineRecordId,
} from './parts';
import {
  ChevronRight,
  ClockIcon,
  ContextsIcon,
  TasksIcon,
  DecisionsIcon,
  FilesIcon,
  EditIcon,
  OpenIcon,
  PowerIcon,
} from './icons';
import { useSessionDetail, useEndSession, type SessionListRow } from './hooks';
import styles from './Sessions.module.css';
import { apiErrorMessage } from '../../api/request';

const PILL_LABEL: Record<SessionStatus, string> = {
  live: 'live',
  dormant: 'dormant',
  ended: 'ended',
};

function Metric({ value, label, teal }: { value: React.ReactNode; label: string; teal?: boolean }) {
  return (
    <span className={styles.metric}>
      <span className={cx(styles.metricV, teal && styles.metricTeal)}>{value}</span>
      <span className={styles.metricK}>{label}</span>
    </span>
  );
}

const ExpandedBody: React.FC<{
  id: string;
  /** DOM id the header button's `aria-controls` points at (accordion pairing). */
  bodyId: string;
  row: SessionListRow;
  /** Show the "End session" control (only for a not-yet-ended session). */
  canEnd: boolean;
  onEdit: () => void;
}> = ({ id, bodyId, row, canEnd, onEdit }) => {
  const navigate = useNavigate();
  const { data: detail, isLoading, isError, error } = useSessionDetail(id, true);
  const [showAll, setShowAll] = React.useState(false);
  const [confirmEnd, setConfirmEnd] = React.useState(false);
  const endMutation = useEndSession();

  if (isLoading) {
    return (
      <div id={bodyId} className={styles.bodyState}>
        <Spinner size="md" />
      </div>
    );
  }
  if (isError) {
    return (
      <div id={bodyId} className={styles.bodyState}>
        <Alert variant="error" title="Couldn't load this session">
          {apiErrorMessage(error, 'Failed to load session detail.')}
        </Alert>
      </div>
    );
  }

  const events = buildTimeline(detail);
  const shown = showAll ? events : events.slice(0, SESSIONS_CONFIG.timelineInitialCount);
  const model = detail?.ai_model ?? row.ai_model;

  return (
    <div id={bodyId} className={styles.body}>
      <div className={styles.bodyTop}>
        <div className={styles.bodyMeta}>
          <span>
            session <Code>{row.display_id ?? id.slice(0, 8)}</Code>
          </span>
          <span>· actor <b>{actorLabel(row.actor)}</b></span>
          <span>· project <b>{row.project_name ?? 'Unassigned'}</b></span>
          {model && <span>· {model}</span>}
        </div>
        <div className={styles.bodyActs}>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <EditIcon size={14} /> Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={() => navigate(`/sessions/${id}`)}>
            <OpenIcon size={14} /> Open
          </Button>
          {canEnd && (
            <Button size="sm" variant="danger" onClick={() => setConfirmEnd(true)}>
              <PowerIcon size={14} /> End session
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="End this session?"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmEnd(false)}
              disabled={endMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={endMutation.isPending}
              onClick={() =>
                endMutation.mutate(id, { onSuccess: () => setConfirmEnd(false) })
              }
            >
              End session
            </Button>
          </>
        }
      >
        {endMutation.isError && (
          <Alert variant="error" title="Couldn't end session">
            {apiErrorMessage(endMutation.error, 'Ending the session failed.')}
          </Alert>
        )}
        <Text variant="body" tone="faint">
          Ending closes this session and computes its final productivity score. Later work
          will need a fresh session — this cannot be undone.
        </Text>
      </Modal>

      <div className={styles.drow}>
        {/*
          ── THE `??` TRAP (an earlier task §3) ─────────────────────────────────────────
          `??` is NULLISH-coalescing: it falls through on null/undefined only. A broken
          `0` is neither, so it WINS over every correct fallback behind it. These tiles
          used to chain `detail?.contexts_created ?? row.contexts_created ??
          row.context_count`, and the first two came from the denormalized counter
          columns that SessionRepo.finish() zeroed — so a session with 30 contexts
          rendered "0" while a correct value sat unread at the end of the chain.

          The fix is NOT to reorder the chain (a reorder leaves the trap loaded for the
          next reader). Every count below is now DERIVED server-side from the child
          tables on BOTH the list and the detail read, so there is one correct source and
          nothing to fall back to. `?? row.*` remains only to render the collapsed→
          expanded transition before `detail` has loaded, and both sides now agree.

          Tokens keep a real fallback because they are genuinely two different reads of
          the same non-recomputable column, not a broken one and a good one.
        */}
        <StatTile
          label="Contexts"
          value={formatCount(detail?.context_count ?? row.context_count)}
          icon={<ContextsIcon size={16} className={styles.violetIco} />}
        />
        <StatTile
          label="Tasks"
          value={formatCount(detail?.task_count ?? row.task_count)}
          icon={<TasksIcon size={16} className={styles.greenIco} />}
        />
        <StatTile
          label="Decisions"
          value={formatCount(detail?.decision_count ?? row.decision_count)}
          icon={<DecisionsIcon size={16} className={styles.blueIco} />}
        />
        <StatTile label="Tokens" value={formatTokens(detail?.total_tokens ?? row.total_tokens)} />
        <StatTile
          label="Files"
          value={formatCount(detail?.files_modified_count ?? row.files_modified_count)}
          icon={<FilesIcon size={16} className={styles.tealIco} />}
        />
      </div>

      <SectionHead icon={<ClockIcon size={15} />} hint="most recent first">
        Activity in this session
      </SectionHead>

      {events.length === 0 ? (
        <Text variant="body" tone="faint">
          No recorded activity in this session yet.
        </Text>
      ) : (
        <>
          <div className={styles.timeline}>
            {shown.map((ev) => (
              <div key={ev.key} className={styles.tlItem}>
                <span className={styles.tlTime}>{formatRelative(ev.at)}</span>
                <span className={styles.tlRail}>
                  <span className={styles.tlNode} aria-hidden="true" />
                </span>
                <span className={styles.tlMain}>
                  <span className={styles.tlHead}>
                    <Badge variant={KIND_TONE[ev.kind]}>{ev.kind}</Badge>
                    {ev.sub && (
                      <Text variant="data" tone="faintest">
                        {ev.sub}
                      </Text>
                    )}
                  </span>
                  <span className={styles.tlTitle}>{ev.title}</span>
                  <TimelineRecordId event={ev} className={styles.tlId} />
                </span>
              </div>
            ))}
          </div>
          {events.length > SESSIONS_CONFIG.timelineInitialCount && (
            <button type="button" className={styles.moreLink} onClick={() => setShowAll((v) => !v)}>
              {showAll
                ? 'Show fewer'
                : `Show ${events.length - SESSIONS_CONFIG.timelineInitialCount} earlier events`}
            </button>
          )}
        </>
      )}
    </div>
  );
};

export const StreamCard: React.FC<{
  row: SessionListRow;
  status: SessionStatus;
  onEdit: (row: SessionListRow) => void;
}> = ({ row, status, onEdit }) => {
  // Every card mounts COLLAPSED. Expanding is what fires the per-session detail read,
  // so an auto-open card also spends a request nobody asked for.
  const [open, setOpen] = React.useState(false);
  const dotVar = projectDotVar(row.project_id);
  const title = row.title || `Session ${row.id.slice(0, 8)}`;
  const live = status !== 'ended';
  const bodyId = `session-stream-body-${row.id}`;

  return (
    <div className={cx(styles.stream, open && styles.streamOpen, live && open && styles.streamLive)}>
      <button
        type="button"
        className={styles.stHead}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={15} className={cx(styles.chev, open && styles.chevOpen)} />
        <span className={styles.stProj}>
          <span
            className={styles.pdot}
            style={{ background: `var(${dotVar})`, boxShadow: `0 0 8px var(${dotVar})` }}
            aria-hidden="true"
          />
          <span className={styles.pn}>{row.project_name ?? 'Unassigned'}</span>
          <ActorChip actor={row.actor} />
          <Text variant="body" tone="faint" className={styles.stTitle}>
            {title}
          </Text>
          <StatusPill tone={status === 'live' ? 'active' : status === 'dormant' ? 'dormant' : 'ended'}>
            {PILL_LABEL[status]}
          </StatusPill>
        </span>
        <span className={styles.stRight}>
          <span className={styles.stMetrics}>
            {/* Same derived fields as the expanded card above, so the collapsed row and
                the expanded card can never disagree (a UI acceptance criterion). `row.total_tokens` had no fallback at all and never needed one
                — it is the only durable token record. */}
            <Metric teal value={formatCount(row.context_count)} label="ctx" />
            <Metric value={formatCount(row.task_count)} label="tasks" />
            <Metric value={formatTokens(row.total_tokens)} label="tok" />
          </span>
          <span className={styles.stSeen}>{formatRelative(lastSeen(row))}</span>
        </span>
      </button>

      {open && (
        <ExpandedBody
          id={row.id}
          bodyId={bodyId}
          row={row}
          canEnd={live}
          onEdit={() => onEdit(row)}
        />
      )}
    </div>
  );
};

export default StreamCard;
