/**
 * NewSessionModal — the manual "New session" control. A human in
 * Command can now START a session; previously `api.sessions.start` had ZERO call
 * sites (dead lifecycle method) and only an AGENT could open a session via the MCP
 * `session_start` tool. Writes through `api.sessions.start` via the useStartSession
 * mutation, mirroring SessionEditDrawer's shape (P0.3 primitives, unified client).
 *
 * SCOPE: intentionally MINIMAL — an optional title + optional project. The richer
 * start form (AI model / goal / tags, the old StartSessionModal) is deferred to the
 * blocked Sessions IA redesign, so this does not build ahead of that decision.
 *
 * ── WHAT DECIDES THE SESSION'S PROJECT ───────────────────────────────────────────────
 * The BODY's `projectId`. `X-Project-ID` neither survives the proxy nor is read by the
 * controller that creates the session — two independent facts, either of which could be
 * changed alone, so both are pinned by the `sessionStartBodyGovernsProject` tests (one
 * per service). If those go red, THIS paragraph is what became wrong.
 *
 * The field is therefore the mechanism, and it is SEEDED from the Sessions page's own
 * selection — so a session started from a page showing project X names X. It falls back
 * to "auto-detect" only when the page has no single project to inherit ('all', or
 * unresolved), which is the one case where deferring to mcp-server's own detection is
 * the honest answer.
 *
 * `scope()` is still passed, because it is the house rule for every write and this
 * endpoint is the exception rather than the pattern. It is NOT what makes the write land
 * correctly here — do not read its presence as the guarantee.
 *
 * When no scope can be produced at all (`pageScope()` throws rather than falling back —
 * see api/http/projectScope.ts), or the field holds a project that is not in the list,
 * the Start button is DISABLED. Refusing to start is the correct outcome; starting a
 * session against a project that may not exist is not.
 */
import React from 'react';
import type { AxiosRequestConfig } from 'axios';
import {
  Modal,
  Form,
  Field,
  Input,
  Button,
  Alert,
  ProjectSelect,
  ALL_PROJECTS_VALUE,
  UNASSIGNED_PROJECT_VALUE,
} from '../../components/ui';
import { useProjectContext } from '../../contexts/ProjectContext';
import { scopedRequestConfig } from '../../api/http/projectScope';
import { useStartSession } from './hooks';
import { apiErrorMessage } from '../../api/request';

export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Pre-select a project — the Sessions page's own selection (`usePageProject().projectId`).
   * The 'all' sentinel means "no project pinned" → the field defaults to auto-detect.
   */
  defaultProjectId?: string;
  /**
   * The PAGE's per-request scope (`usePageProject().scope`). Used when the form leaves the
   * project on auto-detect. THROWS when the page has no project — see the header; callers
   * must not substitute a silently-unscoped config.
   */
  pageScope: () => AxiosRequestConfig;
}

/** The form's "no project pinned" value. The shared primitive owns it, not this file. */
const NO_PROJECT = UNASSIGNED_PROJECT_VALUE;

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  open,
  onClose,
  defaultProjectId,
  pageScope,
}) => {
  const mutation = useStartSession();
  // The ONE central project list + sort (contexts/ProjectContext), the same source the
  // page's selector reads — not a second `/api/projects` fetch with its own ordering.
  const { allProjects, loading: projectsLoading, projectsUnavailable } = useProjectContext();
  const [title, setTitle] = React.useState('');
  const [projectId, setProjectId] = React.useState<string>(NO_PROJECT);

  const selectableProjects = React.useMemo(
    () =>
      allProjects
        .filter((p) => Boolean(p.id))
        .map((p) => ({ id: p.id, name: p.name ?? p.id.slice(0, 8) })),
    [allProjects],
  );

  /**
   * THE SUBMITTABLE VALUE SET. `projectId` is form state, and form state outlives the
   * list that produced it — the modal is seeded from the page, whose selection is held
   * provisionally while the list is unresolved. So membership is re-derived on every
   * render from the list as it stands NOW, and it is what gates the button. Without it a
   * seeded id that names nothing reachable is submitted as the session's project.
   */
  const submittableProjectIds = React.useMemo(
    () => new Set<string>([NO_PROJECT, ...selectableProjects.map((p) => p.id)]),
    [selectableProjects],
  );
  const projectIsSubmittable = submittableProjectIds.has(projectId);

  // Re-seed the form each time the modal opens (fresh title; pre-select the pinned
  // project filter if one is active).
  React.useEffect(() => {
    if (open) {
      setTitle('');
      setProjectId(
        defaultProjectId && defaultProjectId !== ALL_PROJECTS_VALUE
          ? defaultProjectId
          : NO_PROJECT,
      );
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * The scope this write will carry, or `null` when none can be produced. Computed rather
   * than thrown at submit time so the button can be disabled instead of the click failing.
   */
  const writeScope = React.useMemo<AxiosRequestConfig | null>(() => {
    try {
      return projectId !== NO_PROJECT ? scopedRequestConfig(projectId) : pageScope();
    } catch {
      // scopedRequestConfig / pageScope throw rather than fall back to the ambient
      // project. That is the contract; here it means "cannot start", not "start anyway".
      return null;
    }
  }, [projectId, pageScope]);

  const canSubmit = !!writeScope && projectIsSubmittable;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(
      {
        input: {
          title: title.trim() || undefined,
          projectId: projectId !== NO_PROJECT ? projectId : undefined,
        },
        scope: writeScope,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start a new session"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-session-form"
            loading={mutation.isPending}
            disabled={!canSubmit}
          >
            Start session
          </Button>
        </>
      }
    >
      <Form id="new-session-form" onSubmit={submit}>
        {mutation.isError && (
          <Alert variant="error" title="Couldn't start session">
            {apiErrorMessage(mutation.error, 'Start failed.')}
          </Alert>
        )}
        <Field label="Title" hint="Optional — name this sitting">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Afternoon review"
          />
        </Field>
        <Field label="Project" hint="Optional — scope the session to a project">
          <ProjectSelect
            projects={selectableProjects}
            value={projectId}
            onChange={setProjectId}
            allowUnassigned
            loading={projectsLoading}
            unavailable={projectsUnavailable}
            aria-label="Session project"
          />
        </Field>
      </Form>
    </Modal>
  );
};

export default NewSessionModal;
