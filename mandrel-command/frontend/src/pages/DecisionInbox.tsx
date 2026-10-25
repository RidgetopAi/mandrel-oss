/**
 * DecisionInbox — "answerable in seconds, several at a sitting" (the operator).
 * Every OPEN or DISCUSSING decision for the page's project, soonest deadline first then
 * newest: its question, each option's label/pros/cons/recommended marker, one radio, a
 * note, a Decide button and a Discuss button. THE DECISION INBOX (an earlier decision
 * and its follow-up).
 *
 * Reuses the Decisions page's data layer (`api.decisions.*` via react-query,
 * `usePageProject` for scope) and the shared UI primitives — no second card system, no
 * second project selector (see pages/noPageProjectSelect.guard.test.ts).
 */
import React from 'react';
import { Alert, Empty, Heading, Spinner, Text } from '../components/ui';
import { usePageProject } from '../hooks/usePageProject';
import { useDecisionInboxList, useAnswerDecision, useDiscussDecision } from './decisionInbox/hooks';
import { DecisionInboxCard } from './decisionInbox/DecisionInboxCard';
import { id8 } from './projects/parts';
import { apiErrorMessage } from '../api/request';
import type { Decision } from '../types/decision';
import styles from './decisionInbox/DecisionInbox.module.css';

interface Confirmation {
  id: string;
  message: string;
}

const DecisionInbox: React.FC = () => {
  const project = usePageProject();

  const list = useDecisionInboxList({
    projectId: project.projectId,
    scope: project.scope,
    enabled: project.ready,
  });

  const answerMutation = useAnswerDecision(project.scope);
  const discussMutation = useDiscussDecision(project.scope);

  // Local, immediate outcome state — the card leaves the inbox and the confirmation
  // appears the moment the write succeeds, rather than waiting on the background
  // list-invalidation refetch to settle (which still runs, and reconciles the truth).
  const [dismissedIds, setDismissedIds] = React.useState<Set<string>>(new Set());
  const [discussingIds, setDiscussingIds] = React.useState<Set<string>>(new Set());
  const [confirmations, setConfirmations] = React.useState<Confirmation[]>([]);

  const handleAnswer = React.useCallback(
    async (decision: Decision, option: string, note: string) => {
      await answerMutation.mutateAsync({ id: decision.id, option, note: note || undefined });
      const label = decision.options?.find((o) => o.key === option)?.label ?? option;
      setDismissedIds((prev) => new Set(prev).add(decision.id));
      setConfirmations((prev) => [
        { id: decision.id, message: `Decided: "${label}" — /r/${id8(decision.id)}` },
        ...prev,
      ]);
    },
    [answerMutation],
  );

  const handleDiscuss = React.useCallback(
    async (decision: Decision, note: string) => {
      await discussMutation.mutateAsync({ id: decision.id, note: note || undefined });
      setDiscussingIds((prev) => new Set(prev).add(decision.id));
    },
    [discussMutation],
  );

  const visible = list.decisions.filter((d) => !dismissedIds.has(d.id));

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Decision Inbox
          </Heading>
          <Text variant="data" tone="faintest">
            {project.projectName ? `for ${project.projectName}` : ''}
          </Text>
        </div>
        <Text variant="body" tone="faint">
          What&apos;s waiting on you — answer here, or send back for more discussion.
        </Text>
      </header>

      {confirmations.length > 0 && (
        <div className={styles.confirmations}>
          {confirmations.map((c) => (
            <Alert
              key={c.id}
              variant="success"
              onClose={() => setConfirmations((prev) => prev.filter((x) => x.id !== c.id))}
            >
              {c.message}
            </Alert>
          ))}
        </div>
      )}

      {!project.ready && !project.loading ? (
        <Empty title="No project selected" description="Pick a project from the topbar to see its inbox." />
      ) : list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <Alert variant="error" title="Couldn't load the inbox">
          {apiErrorMessage(list.error, 'Failed to load the decision inbox.')}
        </Alert>
      ) : visible.length === 0 ? (
        <Empty title="Inbox zero" description="Nothing open or in discussion right now." />
      ) : (
        <div className={styles.cards}>
          {visible.map((decision) => (
            <DecisionInboxCard
              key={decision.id}
              decision={decision}
              discussing={discussingIds.has(decision.id)}
              onAnswer={handleAnswer}
              onDiscuss={handleDiscuss}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default DecisionInbox;
