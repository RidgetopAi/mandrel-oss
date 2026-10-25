/**
 * DecisionReader — the mock's right column (the "why ledger" reader): a header (type /
 * impact / status pills + outcome pill, id link + relative time + project, copy-id +
 * record-outcome icons), the body sections (Problem, Decision, Rationale, Alternatives
 * considered, Success criteria, Outcome/learning loop), and a footer (Affects chips + tags
 * + the typed-edge ThreadBox — the moat). Owns its loading / empty / error state.
 *
 * DATA-GAP POLICY: every section renders ONLY from real fields. Empty
 * `rationale` / `successCriteria` / `alternatives` / `affected_components` render an honest
 * "not recorded" state or are omitted — never fabricated. `created_by` is not serialised by
 * the backend today, so the "by X" chip is omitted (not faked).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Spinner, Empty, Alert, cx } from '../../components/ui';
import {
  ProblemIcon,
  CheckIcon,
  RationaleIcon,
  ListIcon,
  StarIcon,
  ClockIcon,
  XIcon,
  CopyIcon,
  EditIcon,
} from './icons';
import { ThreadBox } from './ThreadBox';
import {
  typeLabel,
  typeTone,
  impactLabel,
  impactTone,
  outcomeLabel,
  outcomeDotVar,
} from './config';
import { formatRelative, id8 } from './parts';
import { buildNavHref } from '../../utils/navIdLinkify';
import type { Decision } from '../../types/decision';
import type { RecordLink } from '../../types/recordLink';
import styles from './Decisions.module.css';
import { apiErrorMessage } from '../../api/request';

export interface DecisionReaderProps {
  decision: Decision | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  links: RecordLink[] | undefined;
  linksLoading: boolean;
  linksError: boolean;
  linksErrorObj: unknown;
  onEdit: (dec: Decision) => void;
}

const CopyIdButton: React.FC<{ id: string }> = ({ id }) => {
  const [copied, setCopied] = React.useState(false);
  const copy = React.useCallback(() => {
    void navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [id]);
  return (
    <button
      type="button"
      className={styles.ricon}
      title={copied ? 'Copied' : 'Copy id'}
      aria-label="Copy id"
      onClick={copy}
    >
      {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
    </button>
  );
};

/** A section with a header icon + label; children carry the body. */
const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({
  icon,
  title,
  children,
}) => (
  <div className={styles.sec}>
    <div className={styles.secH}>
      <span className={styles.secHi}>{icon}</span>
      {title}
    </div>
    {children}
  </div>
);

/** A plain-text body paragraph, or an honest "not recorded" placeholder when empty. */
const Prose: React.FC<{ text?: string | null; empty: string }> = ({ text, empty }) => {
  const value = (text ?? '').trim();
  if (!value) return <p className={cx(styles.secP, styles.secEmpty)}>{empty}</p>;
  return <p className={styles.secP}>{value}</p>;
};

export const DecisionReader: React.FC<DecisionReaderProps> = ({
  decision,
  isLoading,
  isError,
  error,
  links,
  linksLoading,
  linksError,
  linksErrorObj,
  onEdit,
}) => {
  if (isLoading) {
    return (
      <div className={cx(styles.reader, styles.readerState)}>
        <Spinner size="lg" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={cx(styles.reader, styles.readerState)}>
        <Alert variant="error" title="Couldn't load this decision">
          {apiErrorMessage(error, 'Failed to load the decision.')}
        </Alert>
      </div>
    );
  }
  if (!decision) {
    return (
      <div className={cx(styles.reader, styles.readerState)}>
        <Empty title="Select a decision" description="Choose a decision from the list to read the why." />
      </div>
    );
  }

  const dec = decision;
  const alternatives = (dec.alternatives ?? []).filter((a) => a && a.trim());
  const affected = (dec.affected_components ?? []).filter((a) => a && a.trim());
  const tags = dec.tags ?? [];

  return (
    <div className={styles.reader}>
      <div className={styles.rhead}>
        <Badge variant={typeTone(dec.decision_type)}>{typeLabel(dec.decision_type)}</Badge>
        {dec.impact_level && (
          <Badge variant={impactTone(dec.impact_level)}>{impactLabel(dec.impact_level)} impact</Badge>
        )}
        {dec.status && <Badge variant="neutral">{dec.status.replace(/_/g, ' ')}</Badge>}
        {dec.outcomeStatus && (
          <span className={styles.outcome}>
            <span
              className={styles.outcomeDot}
              style={{ background: `var(${outcomeDotVar(dec.outcomeStatus)})` }}
              aria-hidden="true"
            />
            {outcomeLabel(dec.outcomeStatus)}
          </span>
        )}
        <span className={styles.rmeta}>
          <Link className={styles.idlink} to={buildNavHref(dec.id)}>
            {id8(dec.id)}
          </Link>
          <span>· {formatRelative(dec.created_at)}</span>
          {dec.created_by && <span>· by {dec.created_by}</span>}
          {dec.project_name && <span>· {dec.project_name}</span>}
          <CopyIdButton id={dec.id} />
          <button
            type="button"
            className={styles.ricon}
            title="Record outcome"
            aria-label="Record outcome"
            onClick={() => onEdit(dec)}
          >
            <EditIcon size={15} />
          </button>
        </span>
      </div>

      <div className={styles.rbody}>
        <h3 className={styles.rtitle}>{dec.title}</h3>

        <Section icon={<ProblemIcon size={15} />} title="Problem">
          <Prose text={dec.problem} empty="No problem statement recorded." />
        </Section>

        <Section icon={<CheckIcon size={15} />} title="Decision">
          <Prose text={dec.decision} empty="No decision text recorded." />
        </Section>

        <Section icon={<RationaleIcon size={15} />} title="Rationale">
          <Prose text={dec.rationale} empty="No rationale recorded." />
        </Section>

        <Section icon={<ListIcon size={15} />} title="Alternatives considered">
          {alternatives.length === 0 ? (
            <p className={cx(styles.secP, styles.secEmpty)}>No alternatives recorded.</p>
          ) : (
            alternatives.map((alt, i) => (
              <div key={i} className={styles.alt}>
                <div className={styles.altN}>
                  <span className={styles.altX} aria-hidden="true">
                    <XIcon size={10} />
                  </span>
                  {alt}
                </div>
              </div>
            ))
          )}
        </Section>

        <Section icon={<StarIcon size={15} />} title="Success criteria">
          {dec.successCriteria && dec.successCriteria.trim() ? (
            <div className={styles.critBox}>
              <p>{dec.successCriteria}</p>
            </div>
          ) : (
            <p className={cx(styles.secP, styles.secEmpty)}>No success criteria recorded.</p>
          )}
        </Section>

        <Section icon={<ClockIcon size={15} />} title="Outcome · learning loop">
          <div className={styles.loopBox}>
            <div className={styles.loopRow}>
              <span
                className={styles.loopDot}
                style={{ background: `var(${outcomeDotVar(dec.outcomeStatus)})` }}
                aria-hidden="true"
              />
              {outcomeLabel(dec.outcomeStatus)}
              {dec.implementationStatus && (
                <span className={styles.loopImpl}>· {dec.implementationStatus.replace(/_/g, ' ')}</span>
              )}
            </div>
            <Prose
              text={dec.outcomeNotes ?? dec.lessonsLearned}
              empty="No outcome notes yet — record the verdict once this decision has been exercised."
            />
          </div>
        </Section>
      </div>

      <div className={styles.rfoot}>
        {affected.length > 0 && (
          <div className={styles.chipRow}>
            <span className={styles.chipLbl}>Affects</span>
            {affected.map((c) => (
              <span key={c} className={styles.achip}>
                {c}
              </span>
            ))}
          </div>
        )}
        {tags.length > 0 && (
          <div className={styles.chipRow}>
            <span className={styles.chipLbl}>Tags</span>
            {tags.map((t) => (
              <span key={t} className={cx(styles.achip, t.startsWith('ref:') && styles.achipRef)}>
                {t}
              </span>
            ))}
          </div>
        )}
        <ThreadBox
          links={links}
          isLoading={linksLoading}
          isError={linksError}
          error={linksErrorObj}
        />
      </div>
    </div>
  );
};

export default DecisionReader;
