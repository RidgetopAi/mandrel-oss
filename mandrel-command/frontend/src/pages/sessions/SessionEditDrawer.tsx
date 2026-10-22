/**
 * SessionEditDrawer — edit a session's metadata (title / description / goal / tags)
 * in a focus-trapped P0.3 Drawer, writing through `api.sessions.update` via the
 * useUpdateSession mutation. Replaces the old antd SessionEditModal for the list.
 */
import React from 'react';
import { Drawer, Form, Field, Input, Textarea, Button, Alert } from '../../components/ui';
import { useUpdateSession, type SessionListRow } from './hooks';
import { apiErrorMessage } from '../../api/request';

export interface SessionEditDrawerProps {
  session: SessionListRow | null;
  open: boolean;
  onClose: () => void;
}

export const SessionEditDrawer: React.FC<SessionEditDrawerProps> = ({ session, open, onClose }) => {
  const mutation = useUpdateSession();
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [goal, setGoal] = React.useState('');
  const [tags, setTags] = React.useState('');

  // Re-seed the form whenever a different session opens the drawer.
  React.useEffect(() => {
    if (open && session) {
      setTitle(session.title ?? '');
      setDescription(session.description ?? '');
      setGoal(session.session_goal ?? '');
      setTags((session.tags ?? []).join(', '));
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session?.id]);

  if (!session) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      {
        id: session.id,
        updates: {
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          session_goal: goal.trim() || undefined,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Edit session"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="session-edit-form" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <Form id="session-edit-form" onSubmit={submit}>
        {mutation.isError && (
          <Alert variant="error" title="Couldn't save">
            {apiErrorMessage(mutation.error, 'Update failed.')}
          </Alert>
        )}
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Session title" />
        </Field>
        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this session about?"
          />
        </Field>
        <Field label="Goal">
          <Input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Session goal" />
        </Field>
        <Field label="Tags" hint="Comma-separated">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tag-a, tag-b" />
        </Field>
      </Form>
    </Drawer>
  );
};

export default SessionEditDrawer;
