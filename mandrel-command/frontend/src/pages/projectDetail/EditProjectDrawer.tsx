/**
 * EditProjectDrawer — the hero "Edit" affordance: a focus-trapped P0.3 Drawer that writes
 * through `api.projects.update` (an EXISTING endpoint — no new backend surface) via the
 * useUpdateProject mutation. Only the real editable fields are shown (name / description /
 * git repo / root dir), pre-filled from the current record. Zero antd. Mirrors the
 * portfolio CreateProjectDrawer.
 */
import React from 'react';
import { Drawer, Form, Field, Input, Textarea, Button, Alert } from '../../components/ui';
import type { ProjectEntity, CreateProjectRequest } from '../../api/generated';
import { useUpdateProject } from './hooks';
import { apiErrorMessage } from '../../api/request';

export interface EditProjectDrawerProps {
  open: boolean;
  project: ProjectEntity;
  onClose: () => void;
  onSaved?: () => void;
}

export const EditProjectDrawer: React.FC<EditProjectDrawerProps> = ({
  open,
  project,
  onClose,
  onSaved,
}) => {
  const mutation = useUpdateProject(project.id);
  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(project.description ?? '');
  const [gitRepoUrl, setGitRepoUrl] = React.useState(project.git_repo_url ?? '');
  const [rootDirectory, setRootDirectory] = React.useState(project.root_directory ?? '');

  React.useEffect(() => {
    if (open) {
      setName(project.name);
      setDescription(project.description ?? '');
      setGitRepoUrl(project.git_repo_url ?? '');
      setRootDirectory(project.root_directory ?? '');
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const payload: Partial<CreateProjectRequest> = {
      name: trimmed,
      description: description.trim(),
      git_repo_url: gitRepoUrl.trim(),
      root_directory: rootDirectory.trim(),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        onSaved?.();
        onClose();
      },
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Edit project"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="project-edit-form"
            disabled={mutation.isPending || name.trim() === ''}
          >
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <Form id="project-edit-form" onSubmit={submit}>
        {mutation.isError && (
          <Alert variant="error" title="Couldn't save project">
            {apiErrorMessage(mutation.error, 'Update failed.')}
          </Alert>
        )}
        <Field label="Name" hint="Required">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ra-example"
            aria-label="Project name"
            autoFocus
          />
        </Field>
        <Field label="Description" hint="Optional">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this project contains"
            rows={3}
          />
        </Field>
        <Field label="Git repository URL" hint="Optional">
          <Input
            value={gitRepoUrl}
            onChange={(e) => setGitRepoUrl(e.target.value)}
            placeholder="https://github.com/…"
            aria-label="Git repository URL"
          />
        </Field>
        <Field label="Root directory" hint="Optional">
          <Input
            value={rootDirectory}
            onChange={(e) => setRootDirectory(e.target.value)}
            placeholder="/path/to/your/project"
            aria-label="Root directory"
          />
        </Field>
      </Form>
    </Drawer>
  );
};

export default EditProjectDrawer;
