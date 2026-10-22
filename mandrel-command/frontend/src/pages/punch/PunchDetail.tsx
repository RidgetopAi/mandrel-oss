/**
 * PunchDetail — one punch (`/punch/:id`): goal, done-when, proof, project, the stage
 * timeline, the Before / Evidence gallery, inline edit of goal / done-when / proof, delete
 * attachment, and the link to the full task view. A panel, not a page: the parent puts it
 * in a Drawer on desktop and renders it full-page on a phone.
 *
 * `missing` (from a rejected drag or a draft submit) opens the editor with those fields
 * flagged, so the fix is one tap away from the failure.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Input, Textarea, Field, Alert, Spinner, cx } from '../../components/ui';
import { apiErrorMessage } from '../../api/request';
import { formatRelative, id8 } from '../tasks/parts';
import { STATUS_LABEL, statusTone } from '../tasks/config';
import { STAGE_COLUMNS, STAGE_LABEL, PROOF_OPTIONS, PUNCH_CONFIG, proofTint } from './config';
import { effectiveStage, punchOf, stageIndex, missingPunchFields } from './stage';
import { doneWhenDisplayText } from './doneWhenClauses';
import { punchIncompleteMissing } from './punchError';
import { Segmented } from './Segmented';
import { AttachmentGallery } from './AttachmentGallery';
import { useAttachments, useDeleteAttachment, useUpdateTask } from './hooks';
import type { Task, PunchProofKind } from '../../types/task';
import type { TaskUpdateInput } from '../tasks/hooks';
import styles from './Punch.module.css';

export interface PunchDetailProps {
  task: Task | undefined;
  taskLoading: boolean;
  projectName?: string;
  /** Fields the server said were missing — opens the editor with them flagged. */
  missing?: string[];
  onClose: () => void;
}

interface Edit {
  goal: string;
  doneWhen: string;
  proofKind: PunchProofKind | undefined;
}

// This editor predates the structured `doneWhen` contract and only ever
// wrote a plain string — seeding it from an already-STRUCTURED punch would let an
// untouched Save silently REPLACE the clause array with an empty string (data loss).
// It seeds blank for a structured punch instead; `save()` below carries the same guard.
const seed = (task: Task | undefined): Edit => {
  const punch = punchOf(task ?? {});
  return {
    goal: task?.title ?? '',
    doneWhen: typeof punch.doneWhen === 'string' ? punch.doneWhen : '',
    proofKind: punch.proofKind,
  };
};

export const PunchDetail: React.FC<PunchDetailProps> = ({ task, taskLoading, projectName, missing, onClose }) => {
  const [editing, setEditing] = React.useState(false);
  const [edit, setEdit] = React.useState<Edit>(() => seed(task));
  const [serverMissing, setServerMissing] = React.useState<string[]>([]);
  const update = useUpdateTask();
  const attachments = useAttachments(task?.id ?? null);
  const del = useDeleteAttachment();

  // Reseed on a different task; open the editor when arriving with missing fields.
  React.useEffect(() => {
    setEdit(seed(task));
    setEditing(Boolean(missing && missing.length > 0));
    setServerMissing(missing ?? []);
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, missing]);

  if (taskLoading && !task) {
    return (
      <div className={styles.boardState}>
        <Spinner size="lg" />
      </div>
    );
  }
  if (!task) {
    return <Alert variant="warning" title="Punch not found">This punch is not in the current project, or it was deleted.</Alert>;
  }

  const punch = punchOf(task);
  const stage = effectiveStage(task);
  const at = stageIndex(stage);
  const flagged = new Set([...serverMissing, ...(editing ? missingPunchFields({ doneWhen: edit.doneWhen, proofKind: edit.proofKind }) : [])]);

  const save = () => {
    const updates: TaskUpdateInput = {};
    if (edit.goal.trim() !== task.title) updates.title = edit.goal.trim();
    const p: TaskUpdateInput['punch'] = {};
    // NEVER overwrite an already-STRUCTURED doneWhen through this string-only editor (see
    // `seed` above) — only a legacy string/unset value is eligible to be re-written here.
    if (!Array.isArray(punch.doneWhen) && (edit.doneWhen.trim() || '') !== (punch.doneWhen ?? '')) {
      p.doneWhen = edit.doneWhen.trim();
    }
    if (edit.proofKind !== punch.proofKind && edit.proofKind) p.proofKind = edit.proofKind;
    if (Object.keys(p).length > 0) updates.punch = p;
    if (Object.keys(updates).length === 0) {
      setEditing(false);
      return;
    }
    update.mutate(
      { id: task.id, updates },
      {
        onSuccess: () => {
          setEditing(false);
          setServerMissing([]);
        },
        onError: (err) => {
          const miss = punchIncompleteMissing(err);
          if (miss) setServerMissing(miss);
        },
      },
    );
  };

  const canSave = edit.goal.trim().length > 0 && !update.isPending;

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        {editing ? (
          <Field label="Goal" required>
            <Input value={edit.goal} onChange={(e) => setEdit((c) => ({ ...c, goal: e.target.value }))} aria-label="Goal" />
          </Field>
        ) : (
          <h2 className={styles.detailTitle}>{task.title}</h2>
        )}
        <div className={styles.detailBadges}>
          <Badge variant={proofTint(punch.proofKind)}>{punch.proofKind ?? 'no proof kind'}</Badge>
          <Badge variant={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
          <span className={styles.detailProject}>{projectName ?? task.project_name ?? '—'}</span>
        </div>
      </div>

      {update.isError && !punchIncompleteMissing(update.error) && (
        <Alert variant="error" title="Couldn't save">
          {apiErrorMessage(update.error, 'The request failed.')}
        </Alert>
      )}
      {serverMissing.length > 0 && (
        <Alert variant="warning" title="Not ready yet">
          The server still needs: {serverMissing.join(', ')}.
        </Alert>
      )}

      <section className={styles.detailSection}>
        <span className={styles.detailLabel}>Done when</span>
        {editing ? (
          <Field error={flagged.has('doneWhen') ? 'Required before Ready' : undefined}>
            <Textarea
              value={edit.doneWhen}
              onChange={(e) => setEdit((c) => ({ ...c, doneWhen: e.target.value }))}
              rows={PUNCH_CONFIG.listFieldRows}
              aria-label="Done when"
            />
          </Field>
        ) : doneWhenDisplayText(punch.doneWhen) ? (
          <p className={styles.detailProse}>{doneWhenDisplayText(punch.doneWhen)}</p>
        ) : (
          <p className={cx(styles.detailProse, styles.detailEmpty)}>not set</p>
        )}
      </section>

      <section className={styles.detailSection}>
        <span className={styles.detailLabel}>Proof</span>
        {editing ? (
          <Field error={flagged.has('proofKind') ? 'Required before Ready' : undefined}>
            <Segmented
              aria-label="Proof"
              fullWidth
              options={PROOF_OPTIONS}
              value={(edit.proofKind ?? '') as PunchProofKind}
              onChange={(v) => setEdit((c) => ({ ...c, proofKind: v }))}
              invalid={flagged.has('proofKind')}
            />
          </Field>
        ) : (
          <p className={styles.detailProse}>{PROOF_OPTIONS.find((o) => o.value === punch.proofKind)?.label ?? <span className={styles.detailEmpty}>not set</span>}</p>
        )}
      </section>

      {editing ? (
        <div className={styles.detailActions}>
          <Button variant="subtle" onClick={() => { setEditing(false); setEdit(seed(task)); }} disabled={update.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={update.isPending} disabled={!canSave}>
            Save
          </Button>
        </div>
      ) : (
        <div className={styles.detailActions}>
          <Button variant="subtle" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      )}

      <section className={styles.detailSection}>
        <span className={styles.detailLabel}>Stage</span>
        <ol className={styles.timeline} aria-label="Stage timeline">
          {STAGE_COLUMNS.map((c, i) => {
            const state = i < at ? 'past' : i === at ? 'now' : 'next';
            return (
              <li key={c.stage} className={cx(styles.tlItem, styles[`tl_${state}`])} data-state={state}>
                <span className={styles.tlDot} style={state !== 'next' ? { background: `var(${c.dotVar})` } : undefined} aria-hidden="true" />
                <span className={styles.tlLabel}>{STAGE_LABEL[c.stage]}</span>
                {state === 'now' && <span className={styles.tlWhen}>{formatRelative(task.updated_at ?? task.created_at)}</span>}
              </li>
            );
          })}
        </ol>
        {task.status === 'blocked' && (
          <Alert variant="warning" title="Blocked">This punch is in the blocked lane.</Alert>
        )}
      </section>

      {task.description && (
        <section className={styles.detailSection}>
          <span className={styles.detailLabel}>Notes</span>
          <p className={styles.detailProse}>{task.description}</p>
        </section>
      )}

      <AttachmentGallery
        attachments={attachments.data}
        isLoading={attachments.isLoading}
        isError={attachments.isError}
        error={attachments.error}
        onDelete={(a) => del.mutate({ id: a.id, taskId: task.id })}
        deletingId={del.isPending ? del.variables?.id : null}
        deleteError={del.isError ? del.error : undefined}
      />

      <div className={styles.detailMeta}>
        <span>
          punch <b className={styles.mono}>{id8(task.id)}</b>
        </span>
        <span>
          filed <b>{formatRelative(task.created_at)}</b>
        </span>
        <Link to={`/tasks/${task.id}`} className={styles.detailLink}>
          Open in Tasks →
        </Link>
        <Button variant="subtle" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
};

export default PunchDetail;
