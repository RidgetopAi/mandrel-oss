/**
 * PunchForm — "file a punch" (`/punch/new`). Phone-first: one screen, full width, fields in
 * the brief's order (Goal · Done when · Where · Proof · Photo · Touches · Dependencies ·
 * Notes · Kind). The Ready submit is enabled only once Goal, project, and EVERY done-when
 * clause are complete.
 *
 * ── THE STRUCTURED CONTRACT ───────────────────────────────────────────────────────────
 * `doneWhen` is a LIST of clause rows (text / owner lane|human / proof, proof required
 * only for a lane clause) — see `doneWhenClauses.ts`. The Ready button mirrors the API's
 * own `PunchIncompleteError` rules client-side so a caller-fixable gap is caught before
 * the network round trip, not after; the server is still the AUTHORITY (its refusal, if
 * one somehow still arrives, is shown verbatim, never swallowed).
 *
 * ── THE SUBMIT FLOW ──────────────────────────────────────────────
 *   1. POST /api/tasks  { type, title, description, dependencies,
 *                         punch:{doneWhen:[{text,owner,proof?}], proofKind, source:'form', touches},
 *                         stage:'draft', project_id, priority }
 *      `punch` rides the top-level `punch` argument — NEVER `metadata.punch` (an earlier task
 *      folds a `metadata.punch` alternate channel in, but this form never writes one).
 *      `dependencies` rides top-level too; the API mirrors it into `punch.dependsOn` itself.
 *   2. POST /api/tasks/:id/attachments  kind:'before'  — one per photo, downscaled first
 *   3. PUT  /api/tasks/:id  { stage:'ready' }
 * Step 3 can answer 400 PUNCH_INCOMPLETE; then the missing fields are shown inline and
 * the punch is LEFT AS A DRAFT — it is never lost. Any later step failing after step 1
 * likewise leaves a draft on the board with an honest error here, not a vanished punch.
 *
 * The create is SCOPED to the project the form is showing (X-Project-ID + body agree —
 * see tasks/hooks `useCreateTask`), never to the ambient default.
 */
import React from 'react';
import { Form, Field, Input, Textarea, Button, Alert, ProjectSelect } from '../../components/ui';
import { useProjectContext } from '../../contexts/ProjectContext';
import { scopedRequestConfig } from '../../api/http/projectScope';
import { apiErrorMessage } from '../../api/request';
import { useCreateTask, useUpdateTask, useUploadAttachment } from './hooks';
import { Segmented } from './Segmented';
import { PhotoPicker } from './PhotoPicker';
import { ClauseRows } from './ClauseRows';
import { downscaleImage } from './downscale';
import { punchIncompleteMissing } from './punchError';
import { parseListInput } from './listInput';
import {
  clauseComplete,
  clauseRowsFromDoneWhen,
  clausesToPayload,
  type ClauseDraft,
} from './doneWhenClauses';
import {
  PUNCH_CONFIG,
  PUNCH_COPY,
  PROOF_OPTIONS,
  DEFAULT_PROOF_KIND,
  KIND_OPTIONS,
  DEFAULT_PUNCH_KIND,
  DEFAULT_PUNCH_PRIORITY,
} from './config';
import type { PunchMeta, PunchProofKind } from '../../types/task';
import styles from './Punch.module.css';

export interface PunchFormProps {
  /** The page's project — the Where default. */
  pageProjectId: string | undefined;
  /**
   * Seeds the form from an EXISTING punch (an earlier task item 6) — a legacy STRING
   * `doneWhen` loads as one clause row with owner unset, forcing classification before
   * the punch can go back to `ready`; a structured array loads one row per clause.
   * `undefined` (the default, `/punch/new`) starts blank.
   */
  initialPunch?: Pick<PunchMeta, 'doneWhen' | 'proofKind' | 'touches'>;
  /** Filed (and, when `draft`, left incomplete): the parent navigates to the board. */
  onFiled: (id: string, outcome: 'ready' | 'draft') => void;
  onCancel: () => void;
}

interface Draft {
  goal: string;
  clauses: ClauseDraft[];
  /** Raw textbox contents — parsed via `parseListInput` on submit. */
  touches: string;
  dependencies: string;
  projectId: string;
  proofKind: PunchProofKind;
  photos: File[];
  notes: string;
  kind: (typeof KIND_OPTIONS)[number]['value'];
}

type Phase = 'idle' | 'creating' | 'uploading' | 'readying';

export const PunchForm: React.FC<PunchFormProps> = ({
  pageProjectId,
  initialPunch,
  onFiled,
  onCancel,
}) => {
  const { allProjects } = useProjectContext();
  const [d, setD] = React.useState<Draft>(() => ({
    goal: '',
    clauses: clauseRowsFromDoneWhen(initialPunch?.doneWhen),
    touches: (initialPunch?.touches ?? []).join('\n'),
    dependencies: '',
    projectId: pageProjectId ?? '',
    proofKind: initialPunch?.proofKind ?? DEFAULT_PROOF_KIND,
    photos: [],
    notes: '',
    kind: DEFAULT_PUNCH_KIND,
  }));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((c) => ({ ...c, [k]: v }));

  // The page project can settle a tick after mount; seed once, never override a pick.
  React.useEffect(() => {
    if (!d.projectId && pageProjectId) set('projectId', pageProjectId);
  }, [pageProjectId, d.projectId]);

  const scope = React.useCallback(() => scopedRequestConfig(d.projectId), [d.projectId]);
  const create = useCreateTask(scope);
  const update = useUpdateTask();
  const upload = useUploadAttachment();

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [missing, setMissing] = React.useState<string[]>([]);
  const [error, setError] = React.useState<unknown>(null);
  /** A PUNCH_INCOMPLETE refusal at the readying step — the server IS the authority, so its
   * message is shown VERBATIM, never swallowed or paraphrased (an earlier task item 5). With
   * `clausesOk` mirroring the same rules client-side, the Ready button should make this
   * refusal rare; when it still happens, this is what surfaces it. */
  const [readyIncomplete, setReadyIncomplete] = React.useState<unknown>(null);
  const [uploadFailures, setUploadFailures] = React.useState<string[]>([]);

  const goalOk = d.goal.trim().length > 0;
  const clausesOk = d.clauses.length > 0 && d.clauses.every(clauseComplete);
  const busy = phase !== 'idle';
  const canSubmit = goalOk && clausesOk && d.projectId.length > 0 && !busy;

  const projects = React.useMemo(() => allProjects.map((p) => ({ id: p.id, name: p.name })), [allProjects]);

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    setMissing([]);
    setReadyIncomplete(null);
    setUploadFailures([]);
    const touches = parseListInput(d.touches);
    const dependencies = parseListInput(d.dependencies);
    let id: string;
    try {
      setPhase('creating');
      const created = await create.mutateAsync({
        title: d.goal.trim(),
        description: d.notes.trim() || undefined,
        type: d.kind,
        priority: DEFAULT_PUNCH_PRIORITY,
        project_id: d.projectId,
        stage: 'draft',
        punch: {
          doneWhen: clausesToPayload(d.clauses),
          proofKind: d.proofKind,
          source: 'form',
          ...(touches.length > 0 ? { touches } : {}),
        },
        ...(dependencies.length > 0 ? { dependencies } : {}),
      });
      id = created.id;
    } catch (err) {
      setError(err);
      setPhase('idle');
      return;
    }

    // From here the punch EXISTS (as a draft). Nothing below may lose it.
    setPhase('uploading');
    const failures: string[] = [];
    for (const photo of d.photos) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const file = await downscaleImage(photo, {
          aboveBytes: PUNCH_CONFIG.downscaleAboveBytes,
          maxEdgePx: PUNCH_CONFIG.downscaleMaxEdgePx,
          quality: PUNCH_CONFIG.downscaleJpegQuality,
        });
        // eslint-disable-next-line no-await-in-loop
        await upload.mutateAsync({ taskId: id, file, kind: 'before' });
      } catch (err) {
        failures.push(`${photo.name}: ${apiErrorMessage(err, 'upload failed')}`);
      }
    }
    if (failures.length > 0) setUploadFailures(failures);

    setPhase('readying');
    try {
      await update.mutateAsync({ id, updates: { stage: 'ready' } });
    } catch (err) {
      const miss = punchIncompleteMissing(err);
      setPhase('idle');
      if (miss) {
        setMissing(miss);
        setReadyIncomplete(err);
      } else {
        setError(err);
      }
      onFiled(id, 'draft');
      return;
    }
    setPhase('idle');
    onFiled(id, 'ready');
  };

  const missingProof = missing.includes('proofKind');

  return (
    <Form
      className={styles.form}
      gap={4}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error != null && (
        <Alert variant="error" title="Couldn't file the punch">
          {apiErrorMessage(error, 'The request failed.')}
        </Alert>
      )}
      {readyIncomplete != null && (
        <Alert variant="warning" title="Saved as a draft — not ready yet">
          {apiErrorMessage(readyIncomplete, 'The server refused to mark this ready.')}
        </Alert>
      )}
      {uploadFailures.length > 0 && (
        <Alert variant="warning" title="Some photos didn't upload">
          {uploadFailures.join(' · ')}
        </Alert>
      )}

      <Field label={PUNCH_COPY.goalLabel} required>
        <Input
          value={d.goal}
          onChange={(e) => set('goal', e.target.value)}
          placeholder={PUNCH_COPY.goalPlaceholder}
          aria-label="Goal"
          autoFocus
          disabled={busy}
        />
      </Field>

      <Field label={PUNCH_COPY.doneWhenLabel} required>
        <ClauseRows clauses={d.clauses} onChange={(clauses) => set('clauses', clauses)} disabled={busy} />
      </Field>

      <Field label={PUNCH_COPY.whereLabel} required>
        <ProjectSelect
          projects={projects}
          value={d.projectId || undefined}
          onChange={(v) => set('projectId', v)}
          disabled={busy}
          aria-label="Where"
        />
      </Field>

      <Field label={PUNCH_COPY.proofLabel} error={missingProof ? 'The server needs a proof kind' : undefined}>
        <Segmented
          aria-label="Proof"
          fullWidth
          options={PROOF_OPTIONS}
          value={d.proofKind}
          onChange={(v) => set('proofKind', v)}
          invalid={missingProof}
        />
      </Field>

      <Field label={PUNCH_COPY.photoLabel}>
        <PhotoPicker files={d.photos} onChange={(f) => set('photos', f)} disabled={busy} />
      </Field>

      <Field label={PUNCH_COPY.touchesLabel}>
        <Textarea
          value={d.touches}
          onChange={(e) => set('touches', e.target.value)}
          placeholder={PUNCH_COPY.touchesPlaceholder}
          rows={PUNCH_CONFIG.listFieldRows}
          aria-label="Touches"
          disabled={busy}
        />
      </Field>

      <Field label={PUNCH_COPY.dependenciesLabel}>
        <Textarea
          value={d.dependencies}
          onChange={(e) => set('dependencies', e.target.value)}
          placeholder={PUNCH_COPY.dependenciesPlaceholder}
          rows={PUNCH_CONFIG.listFieldRows}
          aria-label="Dependencies"
          disabled={busy}
        />
      </Field>

      <Field label={PUNCH_COPY.notesLabel}>
        <Textarea
          value={d.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder={PUNCH_COPY.notesPlaceholder}
          rows={PUNCH_CONFIG.notesRows}
          aria-label="Notes"
          disabled={busy}
        />
      </Field>

      <Field label={PUNCH_COPY.kindLabel}>
        <Segmented aria-label="Kind" fullWidth options={KIND_OPTIONS} value={d.kind} onChange={(v) => set('kind', v)} />
      </Field>

      <div className={styles.formActions}>
        <Button type="button" variant="subtle" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} disabled={!canSubmit}>
          {busy ? PUNCH_COPY.submitting : PUNCH_COPY.submit}
        </Button>
      </div>
    </Form>
  );
};

export default PunchForm;
