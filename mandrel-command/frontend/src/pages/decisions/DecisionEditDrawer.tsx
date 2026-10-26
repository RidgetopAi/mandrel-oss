/**
 * DecisionEditDrawer — record a decision's OUTCOME / lifecycle (the "why ledger" closing
 * the learning loop) in a focus-trapped P0.3 Drawer, writing through `api.decisions.update`
 * via the useUpdateDecision mutation. Mirrors the Contexts ContextEditDrawer pattern (zero
 * antd). Only the fields the backend PUT accepts are editable (status, outcomeStatus,
 * outcomeNotes, lessonsLearned).
 */
import React from 'react';
import { Drawer, Form, Field, Select, Textarea, Button, Alert } from '../../components/ui';
import { useUpdateDecision } from './hooks';
import type { Decision } from '../../types/decision';
import { apiErrorMessage } from '../../api/request';
import { scopedRequestConfig } from '../../api/http/projectScope';

export interface DecisionEditDrawerProps {
  decision: Decision | null;
  open: boolean;
  onClose: () => void;
  /**
   * The page's project (`usePageProject().projectId`), used ONLY as a fallback when the
   * decision record itself does not carry a `project_id`. See the scope note below.
   */
  pageProjectId: string | undefined;
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'under_review', label: 'Under review' },
  { value: 'superseded', label: 'Superseded' },
  { value: 'deprecated', label: 'Deprecated' },
];

const OUTCOME_OPTIONS = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'too_early', label: 'Too early' },
  { value: 'successful', label: 'Successful' },
  { value: 'mixed', label: 'Mixed' },
  { value: 'failed', label: 'Failed' },
];

export const DecisionEditDrawer: React.FC<DecisionEditDrawerProps> = ({
  decision,
  open,
  onClose,
  pageProjectId,
}) => {
  /**
   * ── THE WRITE SCOPE (an earlier epic §A1) ────────────────────────────────────────────
   * `PUT /api/decisions/:id` is a `requireWriteProjectId` controller: it resolves a
   * project from the REQUEST (header beats body) and hands it to MCP `decision_update`,
   * which scopes the decisionId lookup by it. Send nothing and it resolves to the ambient
   * default — a project this page may not be showing at all.
   *
   * The project to send is THE DECISION'S OWN, not the page's: a decision reached by a
   * `/r/<id8>` short link lives outside the page's selection, and naming the page's
   * project would ask the tool to find that id somewhere it isn't. The page's project is
   * the fallback only for a record whose `project_id` the read model omitted.
   *
   * `scopedRequestConfig` THROWS when neither is a real project id. That is deliberate and
   * it is why `canSave` is false in that state — a write that cannot say where it belongs
   * must not be sent.
   */
  const writeProjectId = decision?.project_id ?? pageProjectId;
  const scope = React.useCallback(
    () => scopedRequestConfig(writeProjectId),
    [writeProjectId],
  );
  const mutation = useUpdateDecision(scope);
  const [status, setStatus] = React.useState('active');
  const [outcomeStatus, setOutcomeStatus] = React.useState('unknown');
  const [outcomeNotes, setOutcomeNotes] = React.useState('');
  const [lessonsLearned, setLessonsLearned] = React.useState('');

  // Re-seed the form whenever a different decision opens the drawer.
  React.useEffect(() => {
    if (open && decision) {
      setStatus(decision.status ?? 'active');
      setOutcomeStatus(decision.outcomeStatus ?? 'unknown');
      setOutcomeNotes(decision.outcomeNotes ?? '');
      setLessonsLearned(decision.lessonsLearned ?? '');
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, decision?.id]);

  if (!decision) return null;

  // No resolvable project → `scope()` would throw. Refuse to offer the write rather than
  // let the user press Save into an exception (or, worse, into the ambient project).
  const canSave = Boolean(writeProjectId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    mutation.mutate(
      {
        id: decision.id,
        updates: {
          status,
          outcomeStatus,
          outcomeNotes,
          lessonsLearned,
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Record outcome"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="decision-edit-form" disabled={mutation.isPending || !canSave}>
            {mutation.isPending ? 'Saving…' : 'Save outcome'}
          </Button>
        </>
      }
    >
      <Form id="decision-edit-form" onSubmit={submit}>
        {mutation.isError && (
          <Alert variant="error" title="Couldn't save">
            {apiErrorMessage(mutation.error, 'Update failed.')}
          </Alert>
        )}
        <Field label="Status">
          <Select options={STATUS_OPTIONS} value={status} onChange={setStatus} aria-label="Status" />
        </Field>
        <Field label="Outcome">
          <Select
            options={OUTCOME_OPTIONS}
            value={outcomeStatus}
            onChange={setOutcomeStatus}
            aria-label="Outcome"
          />
        </Field>
        <Field label="Outcome notes" hint="What actually happened">
          <Textarea
            value={outcomeNotes}
            onChange={(e) => setOutcomeNotes(e.target.value)}
            placeholder="How did this decision play out?"
            rows={5}
          />
        </Field>
        <Field label="Lessons learned" hint="Optional">
          <Textarea
            value={lessonsLearned}
            onChange={(e) => setLessonsLearned(e.target.value)}
            placeholder="What would you do differently?"
            rows={4}
          />
        </Field>
      </Form>
    </Drawer>
  );
};

export default DecisionEditDrawer;
