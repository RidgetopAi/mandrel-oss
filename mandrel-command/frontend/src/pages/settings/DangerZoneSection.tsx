/**
 * Danger zone — irreversible, gated actions. LIVE:
 *   • delete project → api.projects.remove (DELETE /api/projects/:id)
 * Gated by a confirm modal that requires typing the project name (defence against an
 * accidental click). On success we clear the selected project + refresh the list and send
 * the user to the dashboard, so the app never sits on a just-deleted project.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Input, Modal, Text } from '../../components/ui';
import { useProjectContext, useEffectiveProjectId } from '../../contexts/ProjectContext';
import { Group, Row } from './parts';
import { useDeleteProject } from './hooks';
import { apiErrorMessage } from '../../api/request';

const DeleteProjectModal: React.FC<{
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
}> = ({ open, onClose, projectId, projectName }) => {
  const navigate = useNavigate();
  const { refreshProjects } = useProjectContext();
  const mutation = useDeleteProject();
  const [confirmText, setConfirmText] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setConfirmText('');
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const matches = confirmText.trim() === projectName;

  const remove = () => {
    if (!matches) return;
    mutation.mutate(projectId, {
      onSuccess: async () => {
        // No hand-clearing of the ambient project: it is DERIVED from the project list
        // (page-scope epic §C), so refreshing the list is what re-resolves it. The old
        // `setCurrentProject(null)` here was one of the paths that could leave the app
        // with no ambient scope at all.
        try {
          await refreshProjects();
        } catch {
          /* non-fatal — the list will re-fetch on the dashboard */
        }
        onClose();
        navigate('/');
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete project"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={remove} loading={mutation.isPending} disabled={!matches}>
            Delete project
          </Button>
        </>
      }
    >
      {mutation.isError && (
        <Alert variant="error" title="Couldn't delete project">
          {apiErrorMessage(mutation.error, 'Delete failed.')}
        </Alert>
      )}
      <Text variant="body" tone="faint">
        This permanently removes <Text variant="data">{projectName}</Text> and all its
        contexts, tasks and decisions. This cannot be undone.
      </Text>
      <Field label={<>Type <Text variant="data">{projectName}</Text> to confirm</>}>
        <Input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          aria-label="Confirm project name"
          autoComplete="off"
        />
      </Field>
    </Modal>
  );
};

export const DangerZoneSection: React.FC = () => {
  const { allProjects } = useProjectContext();
  const effectiveId = useEffectiveProjectId();
  const [open, setOpen] = React.useState(false);

  // The CONCRETE project the delete targets: the ambient scope, which is now PINNED to
  // the user's default project and is ALWAYS a real UUID or nothing (page-scope epic §C).
  // The old global "All Projects" sentinel branch is gone with the sentinel — it could
  // never reach a UUID route anyway, and there is no longer a state in which the app has
  // a scope that is not a real project.
  const targetProject = React.useMemo(
    () => allProjects.find((p) => p.id === effectiveId) ?? null,
    [allProjects, effectiveId],
  );

  return (
    <Group
      danger
      title="Danger zone"
      description="Irreversible. These are gated actions."
    >
      <Row
        label="Delete this project"
        help={
          targetProject ? (
            <>
              Removes <Text variant="data">{targetProject.name}</Text> and all its contexts,
              tasks and decisions. Cannot be undone.
            </>
          ) : (
            'No project to delete — set a default project in the section above.'
          )
        }
      >
        <Button variant="danger" disabled={!targetProject} onClick={() => setOpen(true)}>
          Delete project…
        </Button>
      </Row>
      {targetProject && (
        <DeleteProjectModal
          open={open}
          onClose={() => setOpen(false)}
          projectId={targetProject.id}
          projectName={targetProject.name}
        />
      )}
    </Group>
  );
};

export default DangerZoneSection;
