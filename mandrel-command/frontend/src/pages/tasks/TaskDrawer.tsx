/**
 * TaskDrawer — the right-side task CRUD surface (the LOCKED presentation, the operator 2026-07-15).
 * One drawer, three modes:
 *
 *  - VIEW (a task is selected): the READ-ONLY panel (<TaskView>), with an Edit button in the
 *    footer that switches to edit in place. This is where every entry point lands — board
 *    card, list row, ops-bar item and `/r/<id8>` deep link — so opening a task can no longer
 *    put the user in front of a live Save and a live Delete they did not ask for.
 *    Create does NOT pass through here: "+ New Task" opens straight into a form.
 *  - EDIT (the user pressed Edit): the task's editable CORE fields (title / description / status /
 *    priority / type / assigned_to / tags) over a real `useUpdateTask` diff-save, the typed
 *    build-story links (the TreeWalker moat — reused via <BuildStory>), record meta, and a
 *    Delete (confirm modal → `useDeleteTask`). The below-board ThreadDetail moved IN here.
 *  - CREATE ("+ New Task"): the same form empty, NO build-story, plus a project field that
 *    lands the task in the effective project (the active one, or the Default under "All
 *    Projects"); when none resolves you MUST pick a project or Save stays disabled.
 *
 * Honest states throughout: loading (detail settling), saving (button busy + form locked),
 * and error (a real Alert with the server message) — nothing fabricated. Enums are sourced
 * from config (DETAIL_STATUS_OPTIONS / PRIORITY_OPTIONS / TYPE_OPTIONS), never inlined.
 */
import React from 'react';
import {
  Drawer,
  Modal,
  Form,
  Field,
  Input,
  Textarea,
  Select,
  Combobox,
  Button,
  Badge,
  Alert,
  Spinner,
  cx,
} from '../../components/ui';
import { useProjectContext, useEffectiveProjectId } from '../../contexts/ProjectContext';
import { scopedRequestConfig } from '../../api/http/projectScope';
import { BuildStory } from './BuildStory';
import { TaskView } from './TaskView';
import {
  ASSIGNEE_COMBOBOX_CONFIG,
  DETAIL_STATUS_OPTIONS,
  PRIORITY_OPTIONS,
  TYPE_OPTIONS,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_TASK_TYPE,
  statusTone,
  typeTint,
  STATUS_LABEL,
} from './config';
import {
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useRestoreTask,
  useTaskActorOptions,
  type TaskUpdateInput,
} from './hooks';
import { TASKS_ASSIGNED_TO } from '../../config/fieldLimits';
import { formatRelative, id8 } from './parts';
import type { CreateTaskRequest } from '../../api/generated/models/CreateTaskRequest';
import type { Task, TaskLink, TaskStatus } from '../../types/task';
import taskStyles from './Tasks.module.css';
import s from './TaskDrawer.module.css';
import { apiErrorMessage } from '../../api/request';

export type TaskDrawerMode = 'view' | 'edit' | 'create';

export interface TaskDrawerProps {
  open: boolean;
  mode: TaskDrawerMode;
  /** The selected task (view/edit mode). May be the freshly-fetched record or the list-row fallback. */
  task?: Task;
  /** Detail still loading (view/edit mode) and no fallback row yet → show a spinner instead. */
  taskLoading?: boolean;
  /** Switch VIEW → EDIT in place. Required for view mode to be escapable; unused elsewhere. */
  onEdit?: () => void;
  /** Typed build-story edges for the selected task (view/edit mode). */
  links?: TaskLink[];
  linksLoading?: boolean;
  linksError?: boolean;
  linksErrorObj?: unknown;
  /** Close the drawer (route cleared / create cancelled by the parent). */
  onClose: () => void;
  /** A task was created → select it (parent navigates to /tasks/:id, reopening in edit mode). */
  onCreated: (id: string) => void;
  /**
   * The PAGE's selected project (`usePageProject().projectId`) — the project create mode
   * opens on. This replaces `useEffectiveProjectId()`, which read the
   * AMBIENT default: with a per-page selector those are different values by design, and
   * seeding the form from the ambient one meant a "+ New Task" on a page showing B
   * defaulted to filing into A.
   */
  pageProjectId?: string;
  /** A task was deleted → close + let the caller drop the selection. */
  onDeleted: () => void;
}

/** The editable content the form owns (project_id is tracked separately — create only). */
interface Content {
  title: string;
  description: string;
  status: TaskStatus;
  priority: CreateTaskRequest['priority'];
  type: CreateTaskRequest['type'];
  assigned_to: string;
  tags: string[];
}

function seedFrom(mode: TaskDrawerMode, task: Task | undefined): Content {
  if (mode !== 'create' && task) {
    return {
      title: task.title ?? '',
      description: task.description ?? '',
      status: (task.status ?? 'todo') as TaskStatus,
      priority: (task.priority ?? DEFAULT_TASK_PRIORITY) as CreateTaskRequest['priority'],
      type: (task.type ?? DEFAULT_TASK_TYPE) as CreateTaskRequest['type'],
      assigned_to: task.assigned_to ?? '',
      tags: [...(task.tags ?? [])],
    };
  }
  return {
    title: '',
    description: '',
    status: 'todo',
    priority: DEFAULT_TASK_PRIORITY,
    type: DEFAULT_TASK_TYPE,
    assigned_to: '',
    tags: [],
  };
}

/** Normalize for dirty-comparison / diffing: trim the free-text fields; leave enums + tags. */
function norm(c: Content) {
  return {
    title: c.title.trim(),
    description: c.description.trim(),
    status: c.status,
    priority: c.priority,
    type: c.type,
    assigned_to: c.assigned_to.trim(),
    tags: c.tags,
  };
}

const MAX_TAGS = 10;
const MAX_TAG_LEN = 50;

export const TaskDrawer: React.FC<TaskDrawerProps> = ({
  open,
  mode,
  task,
  taskLoading = false,
  onEdit,
  links,
  linksLoading = false,
  linksError = false,
  linksErrorObj,
  onClose,
  onCreated,
  onDeleted,
  pageProjectId,
}) => {
  const { allProjects } = useProjectContext();
  // The page's selection when the page has one; the ambient default only for a caller that
  // has no selector of its own. Never the ambient default for a page that does.
  const ambientProjectId = useEffectiveProjectId();
  const effectiveProjectId = pageProjectId ?? ambientProjectId;

  /**
   * ── THE CREATE SCOPE (an earlier epic §A1) ───────────────────────────────────────────
   * Derived from `projectId` — the project the FORM is showing — not from the page and not
   * from the ambient default. The two must agree: the payload's `project_id` is what
   * `controllers/task.ts` files the row under, and a request that names a DIFFERENT
   * project in its header is a request naming two projects, every one of which the
   * backend's resolver authorizes. One project per request, and it is the one on screen.
   *
   * `scopedRequestConfig` throws with no real project id; `canSave` already requires
   * `projectId.length > 0`, so the button is disabled before that can happen.
   */
  const [content, setContent] = React.useState<Content>(() => seedFrom(mode, task));
  const [projectId, setProjectId] = React.useState<string>('');

  const createScope = React.useCallback(() => scopedRequestConfig(projectId), [projectId]);

  /**
   * ASSIGNEE SUGGESTIONS. Scoped to the project the FORM is showing, for
   * the same reason `createScope` is. Fetched only while the drawer is open in an editing
   * mode — browsing the board must not fetch it. `?? []` on purpose: a failed or pending
   * read degrades the control to a plain free-text input rather than blocking the edit.
   */
  const actorOptionsQuery = useTaskActorOptions(
    projectId || undefined,
    createScope,
    open && mode !== 'view' && projectId.length > 0,
  );
  const assigneeOptions = React.useMemo(
    () =>
      (actorOptionsQuery.data ?? []).map((a) => ({
        value: a.actor,
        // The usage count is what makes the canonical spelling the obvious pick. A
        // built-in nobody has used yet honestly shows nothing rather than a fake 0.
        meta: a.taskCount > 0 ? `${a.taskCount}` : undefined,
      })),
    [actorOptionsQuery.data],
  );
  const createMutation = useCreateTask(createScope);
  const updateMutation = useUpdateTask();
  const deleteMutation = useDeleteTask();
  const restoreMutation = useRestoreTask();
  const [tagDraft, setTagDraft] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const baselineRef = React.useRef<Content>(content);

  // Reseed the form whenever the drawer (re)opens or the selected task changes. The task's id
  // is the key — a same-id detail refinement (list-row → full record) keeps user edits intact.
  React.useEffect(() => {
    if (!open) return;
    const seed = seedFrom(mode, task);
    setContent(seed);
    baselineRef.current = seed;
    setTagDraft('');
    setConfirmDelete(false);
    setProjectId(mode === 'create' ? effectiveProjectId ?? '' : task?.project_id ?? '');
    createMutation.reset();
    updateMutation.reset();
    deleteMutation.reset();
    // Reseed only on open/mode/task-id — NOT on every mutation-object identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, task?.id]);

  // Create mode: seed the project once the effective project resolves (it can settle a tick
  // after mount). Never overrides a project the user explicitly picked.
  React.useEffect(() => {
    if (open && mode === 'create' && !projectId && effectiveProjectId) {
      setProjectId(effectiveProjectId);
    }
  }, [open, mode, projectId, effectiveProjectId]);

  const set = <K extends keyof Content>(key: K, value: Content[K]) =>
    setContent((c) => ({ ...c, [key]: value }));

  const dirty = JSON.stringify(norm(content)) !== JSON.stringify(norm(baselineRef.current));
  const titleValid = content.title.trim().length > 0;

  const savePending = mode === 'create' ? createMutation.isPending : updateMutation.isPending;
  const anyPending = savePending || deleteMutation.isPending || restoreMutation.isPending;
  const canSave =
    mode === 'create' ? titleValid && projectId.length > 0 && !anyPending : titleValid && dirty && !anyPending;

  const saveError = mode === 'create' ? createMutation.error : updateMutation.error;

  // ── Tag chip input ─────────────────────────────────────────────────────────
  const addTags = (raw: string) => {
    const parts = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    setContent((c) => {
      const next = [...c.tags];
      for (const p of parts) {
        const t = p.slice(0, MAX_TAG_LEN);
        if (t && !next.includes(t) && next.length < MAX_TAGS) next.push(t);
      }
      return { ...c, tags: next };
    });
    setTagDraft('');
  };
  const removeTag = (t: string) => setContent((c) => ({ ...c, tags: c.tags.filter((x) => x !== t) }));
  const onTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTags(tagDraft);
    } else if (e.key === 'Backspace' && tagDraft === '' && content.tags.length > 0) {
      removeTag(content.tags[content.tags.length - 1]);
    }
  };

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = () => {
    if (!canSave) return;
    if (mode === 'create') {
      const payload: CreateTaskRequest = {
        title: content.title.trim(),
        priority: content.priority,
        project_id: projectId,
        type: content.type,
      };
      const desc = content.description.trim();
      if (desc) payload.description = desc;
      const assignee = content.assigned_to.trim();
      if (assignee) payload.assigned_to = assignee;
      if (content.tags.length > 0) payload.tags = content.tags;
      createMutation.mutate(payload, { onSuccess: (created) => onCreated(created.id) });
      return;
    }

    // Edit: send only the CHANGED fields (the diff vs the saved baseline).
    if (!task) return;
    const b = baselineRef.current;
    const updates: TaskUpdateInput = {};
    if (content.title.trim() !== b.title.trim()) updates.title = content.title.trim();
    if (content.description.trim() !== b.description.trim())
      updates.description = content.description.trim();
    if (content.status !== b.status) updates.status = content.status;
    if (content.priority !== b.priority) updates.priority = content.priority;
    if (content.type !== b.type) updates.type = content.type;
    if (content.assigned_to.trim() !== b.assigned_to.trim())
      updates.assigned_to = content.assigned_to.trim();
    if (JSON.stringify(content.tags) !== JSON.stringify(b.tags)) updates.tags = content.tags;

    updateMutation.mutate(
      { id: task.id, updates },
      {
        onSuccess: () => {
          // Baseline now equals what we saved → the form is clean and stays open on the record.
          baselineRef.current = { ...content };
        },
      },
    );
  };

  const attemptClose = () => {
    if (anyPending) return;
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  };

  const handleDelete = () => {
    if (!task) return;
    deleteMutation.mutate(task.id, { onSuccess: () => onDeleted() });
  };

  /**
   * ARCHIVED — a task whose `archived_at` is set has been SOFT-deleted.
   * It is off the board and out of the counts, but the row is intact, so the footer must
   * offer Restore instead of a second Delete. Read from the record itself, never from
   * which list the user happened to arrive through.
   */
  const isArchived = Boolean(task?.archived_at);

  const handleRestore = () => {
    if (!task) return;
    // Same callback as delete: either way this record has left the current view, and the
    // caller's job (close + drop the selection) is identical.
    restoreMutation.mutate(task.id, { onSuccess: () => onDeleted() });
  };

  const projectName = allProjects.find((p) => p.id === projectId)?.name;
  const showLoading = mode !== 'create' && taskLoading && !task;

  /**
   * VIEW mode's footer carries NO writing control — that is the whole point of the mode.
   * Close, and the one door into edit.
   */
  const viewFooter = (
    <div className={s.footer}>
      <span />
      <div className={s.footerRight}>
        <Button variant="subtle" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" onClick={onEdit} disabled={!task || !onEdit}>
          Edit
        </Button>
      </div>
    </div>
  );

  const editFooter = (
    <div className={s.footer}>
      {mode === 'edit' ? (
        isArchived ? (
          <Button
            variant="primary"
            onClick={handleRestore}
            loading={restoreMutation.isPending}
            disabled={anyPending || !task}
          >
            Restore
          </Button>
        ) : (
          <Button
            variant="danger"
            onClick={() => setConfirmDelete(true)}
            disabled={anyPending || !task}
          >
            Delete
          </Button>
        )
      ) : (
        <span />
      )}
      <div className={s.footerRight}>
        <Button variant="subtle" onClick={attemptClose} disabled={anyPending}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave} loading={savePending} disabled={!canSave}>
          {mode === 'create' ? 'Create task' : 'Save'}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Drawer
        open={open}
        onClose={attemptClose}
        side="right"
        title={mode === 'create' ? 'New task' : mode === 'view' ? 'Task' : 'Edit task'}
        footer={mode === 'view' ? viewFooter : editFooter}
        className={taskStyles.drawerPanel}
      >
        {showLoading ? (
          <div className={s.loadingState}>
            <Spinner size="lg" />
          </div>
        ) : mode === 'view' ? (
          task ? (
            <TaskView
              task={task}
              links={links}
              linksLoading={linksLoading}
              linksError={linksError}
              linksErrorObj={linksErrorObj}
            />
          ) : null
        ) : (
          <Form
            className={s.form}
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
          >
            {saveError && (
              <Alert
                variant="error"
                title={mode === 'create' ? "Couldn't create the task" : "Couldn't save changes"}
              >
                {apiErrorMessage(saveError, 'The request failed.')}
              </Alert>
            )}

            {/* Restore has no confirm modal to carry its own error (it destroys nothing,
                so it needs no confirmation) — surface the real server message here rather
                than letting a failed Restore look like a no-op. an earlier Task. */}
            {restoreMutation.isError && (
              <Alert variant="error" title="Couldn't restore the task">
                {apiErrorMessage(restoreMutation.error, 'The request failed.')}
              </Alert>
            )}

            {/* An archived task is READ-ONLY-ish in spirit: it is off the board until it
                is restored. Say so, so nobody edits a record they cannot find again. */}
            {isArchived && (
              <Alert variant="warning" title="This task is deleted (archived)">
                It is hidden from the board and the counts. Restore it to put it back —
                nothing was destroyed.
              </Alert>
            )}

            {mode === 'create' && (
              <Field
                label="Project"
                required
                hint={
                  projectId ? (
                    <span className={s.landHint}>
                      Lands in <b>{projectName ?? 'the selected project'}</b>
                    </span>
                  ) : allProjects.length === 0 ? (
                    'No projects available — create a project first.'
                  ) : (
                    'Pick the project this task lands in.'
                  )
                }
              >
                <Select
                  options={allProjects.map((p) => ({ value: p.id, label: p.name }))}
                  value={projectId}
                  onChange={setProjectId}
                  placeholder="Select a project…"
                  searchable
                  aria-label="Task project"
                  invalid={!projectId}
                />
              </Field>
            )}

            <Field label="Title" required error={titleValid ? undefined : 'Title is required'}>
              <Input
                value={content.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="What needs doing?"
                aria-label="Task title"
                autoFocus
              />
            </Field>

            <Field label="Description">
              <Textarea
                value={content.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Context, acceptance criteria, links…"
                rows={10}
                aria-label="Task description"
              />
            </Field>

            <div className={s.grid2}>
              {mode === 'edit' && (
                <Field label="Status">
                  <Select
                    options={[...DETAIL_STATUS_OPTIONS]}
                    value={content.status}
                    onChange={(v) => set('status', v as TaskStatus)}
                    aria-label="Task status"
                  />
                </Field>
              )}
              <Field label="Priority">
                <Select
                  options={[...PRIORITY_OPTIONS]}
                  value={content.priority}
                  onChange={(v) => set('priority', v as CreateTaskRequest['priority'])}
                  aria-label="Task priority"
                />
              </Field>
              <Field label="Type">
                <Select
                  options={[...TYPE_OPTIONS]}
                  value={content.type}
                  onChange={(v) => set('type', v as CreateTaskRequest['type'])}
                  aria-label="Task type"
                />
              </Field>
              <Field label="Assignee">
                {/* FREE TEXT WITH SUGGESTIONS, not a Select. The options
                    self-populate from who has actually worked in this project, so the
                    canonical spelling is the path of least resistance and `builder` /
                    `Builder` / `builder (P3 Insight)` stop being three actors — but an
                    unlisted value like 'Operator + Coordinator' stays perfectly legal, because
                    `tasks.assigned_to` is free-form and nothing rejects it. The cap is the
                    COLUMN's, via config/fieldLimits — the same number the zod schema reads. */}
                <Combobox
                  value={content.assigned_to}
                  onChange={(v) => set('assigned_to', v)}
                  options={assigneeOptions}
                  maxVisible={ASSIGNEE_COMBOBOX_CONFIG.maxVisible}
                  maxLength={TASKS_ASSIGNED_TO.max}
                  placeholder={ASSIGNEE_COMBOBOX_CONFIG.placeholder}
                  emptyLabel={ASSIGNEE_COMBOBOX_CONFIG.emptyLabel}
                  aria-label="Task assignee"
                />
              </Field>
            </div>

            <Field
              label="Tags"
              hint={`Enter or comma to add · ${content.tags.length}/${MAX_TAGS}`}
            >
              <div className={s.tags}>
                {content.tags.map((t) => (
                  <span key={t} className={s.tagChip}>
                    {t}
                    <button
                      type="button"
                      className={s.tagRemove}
                      aria-label={`Remove tag ${t}`}
                      onClick={() => removeTag(t)}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                        <path
                          d="M6 6l12 12M18 6L6 18"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </span>
                ))}
                <div className={s.tagInputWrap}>
                  <Input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={onTagKeyDown}
                    onBlur={() => tagDraft.trim() && addTags(tagDraft)}
                    placeholder={content.tags.length >= MAX_TAGS ? 'Max tags reached' : 'Add a tag…'}
                    disabled={content.tags.length >= MAX_TAGS}
                    aria-label="Add a tag"
                  />
                </div>
              </div>
            </Field>

            {mode === 'edit' && task && (
              <>
                <div className={s.storyBlock}>
                  <BuildStory
                    links={links}
                    isLoading={linksLoading}
                    isError={linksError}
                    error={linksErrorObj}
                  />
                </div>
                <div className={s.meta}>
                  <span>
                    <Badge variant={typeTint(task.type)}>{task.type}</Badge>{' '}
                    <Badge variant={statusTone(task.status)}>
                      {STATUS_LABEL[task.status] ?? task.status}
                    </Badge>
                  </span>
                  <span>
                    task <b className={s.metaMono}>{id8(task.id)}</b>
                  </span>
                  <span>
                    created <b>{formatRelative(task.created_at)}</b>
                  </span>
                  <span>
                    updated <b>{formatRelative(task.updated_at)}</b>
                  </span>
                </div>
              </>
            )}
          </Form>
        )}
      </Drawer>

      <Modal
        open={confirmDelete}
        onClose={() => !deleteMutation.isPending && setConfirmDelete(false)}
        title="Delete task?"
        size="sm"
        footer={
          <div className={cx(s.footer, s.footerRight)}>
            <Button
              variant="subtle"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleteMutation.isPending}>
              Delete
            </Button>
          </div>
        }
      >
        <p className={s.confirmText}>
          Delete <b>{task ? task.title : 'this task'}</b>? This removes it from the board and its
          counts. The task is ARCHIVED, not destroyed — find it under the Archived filter in the
          List view and restore it from there.
        </p>
        {deleteMutation.isError && (
          <Alert variant="error" title="Couldn't delete the task">
            {apiErrorMessage(deleteMutation.error, 'The request failed.')}
          </Alert>
        )}
      </Modal>
    </>
  );
};

export default TaskDrawer;
