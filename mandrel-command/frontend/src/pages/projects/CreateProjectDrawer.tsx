/**
 * CreateProjectDrawer — the mock's "New project" affordance: a focus-trapped P0.3 Drawer
 * that writes through `api.projects.create` via the useCreateProject mutation (an EXISTING
 * endpoint — no new backend surface). Only the real CreateProjectRequest fields are
 * editable (name required; description / git repo / root dir optional). Zero antd.
 */
import React from 'react';
import { Drawer, Form, Field, Input, Textarea, Button, Alert } from '../../components/ui';
import type { CreateProjectRequest } from '../../api/generated';
import { useCreateProject } from './hooks';
import { apiErrorMessage } from '../../api/request';

export interface CreateProjectDrawerProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
}

export const CreateProjectDrawer: React.FC<CreateProjectDrawerProps> = ({
  open,
  onClose,
  onCreated,
}) => {
  const mutation = useCreateProject();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [gitRepoUrl, setGitRepoUrl] = React.useState('');
  const [rootDirectory, setRootDirectory] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setGitRepoUrl('');
      setRootDirectory('');
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const payload: CreateProjectRequest = {
      name: trimmed,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(gitRepoUrl.trim() ? { git_repo_url: gitRepoUrl.trim() } : {}),
      ...(rootDirectory.trim() ? { root_directory: rootDirectory.trim() } : {}),
    };
    mutation.mutate(payload, {
      onSuccess: (project) => {
        onCreated?.(project.id);
        onClose();
      },
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="New project"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="project-create-form"
            disabled={mutation.isPending || name.trim() === ''}
          >
            {mutation.isPending ? 'Creating…' : 'Create project'}
          </Button>
        </>
      }
    >
      <Form id="project-create-form" onSubmit={submit}>
        {mutation.isError && (
          <Alert variant="error" title="Couldn't create project">
            {apiErrorMessage(mutation.error, 'Create failed.')}
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

export default CreateProjectDrawer;
