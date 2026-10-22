/**
 * DecisionInboxCard — one open/discussing decision: its question, each option (label,
 * pros, cons, a recommended marker where set), a radio to pick one, a note field, and the
 * Decide / Discuss actions. THE DECISION INBOX.
 *
 * Reuses the SHARED primitives (Card, Badge, Radio, Textarea, Button, Alert) — no second
 * card system. Owns only its OWN option-selection / note / in-flight / error state; the
 * page (DecisionInbox.tsx) owns whether the card is still in the inbox at all (removed on
 * a successful Decide) and the confirmation banner.
 */
import React from 'react';
import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Field, Heading, RadioGroup, Radio, Text, Textarea, Alert } from '../../components/ui';
import type { Decision, DecisionOption } from '../../types/decision';
import { apiErrorMessage } from '../../api/request';
import styles from './DecisionInbox.module.css';

export interface DecisionInboxCardProps {
  decision: Decision;
  /** True once THIS card's Discuss call has succeeded (the row stays; the badge shows). */
  discussing: boolean;
  onAnswer: (decision: Decision, option: string, note: string) => Promise<void>;
  onDiscuss: (decision: Decision, note: string) => Promise<void>;
}

function formatDeadline(deadline: string | null | undefined): string | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const OptionRow: React.FC<{ option: DecisionOption }> = ({ option }) => (
  <div className={styles.option}>
    <div className={styles.optionHead}>
      <Radio value={option.key}>{option.label}</Radio>
      {option.recommended && (
        <Badge variant="teal" pill>
          Recommended
        </Badge>
      )}
    </div>
    <div className={styles.prosCons}>
      <div className={styles.prosConsCol}>
        <Text variant="label" tone="faint">
          Pros
        </Text>
        <ul>
          {option.pros.map((pro, i) => (
            <li key={i}>
              <Text variant="body">{pro}</Text>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.prosConsCol}>
        <Text variant="label" tone="faint">
          Cons
        </Text>
        <ul>
          {option.cons.map((con, i) => (
            <li key={i}>
              <Text variant="body">{con}</Text>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </div>
);

export const DecisionInboxCard: React.FC<DecisionInboxCardProps> = ({
  decision,
  discussing,
  onAnswer,
  onDiscuss,
}) => {
  const [selected, setSelected] = React.useState<string | undefined>(undefined);
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'answer' | 'discuss' | null>(null);

  const options = decision.options ?? [];
  const deadline = formatDeadline(decision.deadline);
  const isDiscussing = discussing || decision.answerStatus === 'discussing';

  const handleDecide = async () => {
    if (!selected || busy) return;
    setError(null);
    setBusy('answer');
    try {
      await onAnswer(decision, selected, note.trim());
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to answer this decision.'));
    } finally {
      setBusy(null);
    }
  };

  const handleDiscuss = async () => {
    if (busy) return;
    setError(null);
    setBusy('discuss');
    try {
      await onDiscuss(decision, note.trim());
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to send this decision for discussion.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-testid={`decision-inbox-card-${decision.id}`}>
      <CardHeader className={styles.cardHead}>
        <Heading level={3} variant="title">
          {decision.question || decision.title}
        </Heading>
        <div className={styles.cardMeta}>
          {isDiscussing && <Badge variant="amber">discussing</Badge>}
          {deadline && (
            <Text variant="data" tone="faint">
              Due {deadline}
            </Text>
          )}
        </div>
      </CardHeader>
      <CardBody>
        {error && (
          <Alert variant="error" title="Couldn't complete that">
            {error}
          </Alert>
        )}
        <RadioGroup
          value={selected}
          onChange={setSelected}
          aria-label={`Options for: ${decision.question || decision.title}`}
          className={styles.options}
          disabled={busy !== null}
        >
          {options.map((option) => (
            <OptionRow key={option.key} option={option} />
          ))}
        </RadioGroup>
        <Field label="Note" hint="Optional — recorded either way">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this one? (optional)"
            rows={2}
            disabled={busy !== null}
          />
        </Field>
      </CardBody>
      <CardFooter className={styles.footer}>
        <Button variant="ghost" onClick={handleDiscuss} loading={busy === 'discuss'} disabled={busy !== null}>
          Discuss
        </Button>
        <Button onClick={handleDecide} disabled={!selected || busy !== null} loading={busy === 'answer'}>
          Decide
        </Button>
      </CardFooter>
    </Card>
  );
};

export default DecisionInboxCard;
