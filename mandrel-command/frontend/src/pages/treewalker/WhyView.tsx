/**
 * WhyView — the Why tab: for ONE record, why it exists and what it led to. Three columns
 * (stacked on a phone): "Because of" (its DECLARED causes, each decision cause carrying the
 * records it spawned, then the branch it is part of), the record itself, and "Same series"
 * (suggested, never causal). "Just before, on this branch" is read by TIME and labelled so.
 * Every cause, spawned record and series entry opens Why for that record; the branch link
 * opens Story. Colour is token-only: a kind's token name comes from config / graphEdges and
 * is handed to CSS as a custom property.
 */
import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cx } from '../../components/ui';
import type { WhyNode, WhyResult } from '../../api/domains/treewalker';
import { WHY_CONFIG, edgeLabel, kindDotVar, trustDotVar, trustLabel } from './config';
import { storyTo, whyTo } from './links';
import { id8 } from './parts';
import styles from './Why.module.css';

export interface WhyViewProps {
  /** The record being explained (full id), or null when none was picked yet. */
  recordId: string | null;
  why: WhyResult | undefined;
  unavailable: boolean;
  isLoading: boolean;
  isError: boolean;
}

const kindStyle = (n: Pick<WhyNode, 'kind' | 'contextType'>): React.CSSProperties =>
  ({ '--role': `var(${kindDotVar(n.contextType ?? n.kind)})` }) as React.CSSProperties;

const kindName = (n: Pick<WhyNode, 'kind' | 'contextType'>): string =>
  n.contextType ? n.contextType : (WHY_CONFIG.kindLabels[n.kind] ?? n.kind);

const when = (iso: string): string => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(WHY_CONFIG.locale, WHY_CONFIG.dateFormat)} ${d.toLocaleTimeString(WHY_CONFIG.locale, WHY_CONFIG.timeFormat)}`;
};

const Trust: React.FC<{ trust: WhyNode['trust'] }> = ({ trust }) => (
  <span className={styles.trust} style={{ '--band': `var(${trustDotVar(trust)})` } as React.CSSProperties}>
    <span className={styles.trustDot} aria-hidden="true" />
    {trustLabel(trust)}
  </span>
);

/** A record row that opens Why for that record. */
const NodeLink: React.FC<{ node: WhyNode; extra?: React.ReactNode }> = ({ node, extra }) => {
  const [params] = useSearchParams();
  return (
    <Link className={styles.node} to={whyTo(params, node.id)} style={kindStyle(node)}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.nodeId}>{id8(node.id)}</span>
      <span className={styles.nodeKind}>{kindName(node)}</span>
      <span className={styles.nodeTitle}>{node.title}</span>
      {extra}
    </Link>
  );
};

const Because: React.FC<{ why: WhyResult }> = ({ why }) => {
  const [params] = useSearchParams();
  const spawnedBy = new Map(why.spawned.map((s) => [s.decisionId, s]));
  return (
    <section className={styles.col} aria-labelledby="tw-why-because" data-testid="tw-why-because">
      <h4 className={styles.colHead} id="tw-why-because">
        {WHY_CONFIG.columns.because}
      </h4>
      {why.causes.length === 0 && <p className={styles.empty}>{WHY_CONFIG.emptyCauses}</p>}
      {why.causes.map((group) => (
        <div className={styles.group} key={group.edgeType}>
          <div className={styles.edge}>{edgeLabel(group.edgeType, 'outgoing')}</div>
          <ul className={styles.list}>
            {group.targets.map((t) => {
              const spawned = spawnedBy.get(t.id);
              return (
                <li key={t.id}>
                  <NodeLink node={t} />
                  {spawned && spawned.total > 0 && (
                    <div className={styles.spawned} data-testid="tw-why-spawned">
                      <div className={styles.spawnedNote}>
                        {spawned.total} other {spawned.total === 1 ? 'record' : 'records'} · {WHY_CONFIG.spawnedNote}
                      </div>
                      <ul className={styles.list}>
                        {spawned.records.map((r) => (
                          <li key={r.id}>
                            <NodeLink node={r} />
                          </li>
                        ))}
                      </ul>
                      {spawned.total > spawned.records.length && (
                        <div className={styles.more}>+ {spawned.total - spawned.records.length} more</div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {why.branch && (
        <div className={styles.group}>
          <div className={styles.edge}>{WHY_CONFIG.branchLabel}</div>
          <Link className={styles.branchLink} to={storyTo(params, why.branch.id)} data-testid="tw-why-branch">
            {why.branch.title}
          </Link>
        </div>
      )}
    </section>
  );
};

const Self: React.FC<{ why: WhyResult }> = ({ why }) => {
  const { record, counts, before } = why;
  return (
    <section className={styles.col} aria-labelledby="tw-why-record" data-testid="tw-why-record">
      <h4 className={styles.colHead} id="tw-why-record">
        This record
      </h4>
      <div className={styles.card} style={kindStyle(record)}>
        <div className={styles.cardMeta}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.nodeKind}>{kindName(record)}</span>
          <span className={styles.nodeId}>{id8(record.id)}</span>
          <Trust trust={record.trust} />
        </div>
        <div className={styles.cardTitle}>{record.title}</div>
        <time className={styles.cardTime} dateTime={record.createdAt}>
          {when(record.createdAt)}
        </time>
        <div className={styles.counts} data-testid="tw-why-counts">
          <span>{counts.declared} declared</span>
          <span>{counts.guessed} guessed</span>
        </div>
      </div>
      <div className={styles.group}>
        <div className={styles.edge}>{WHY_CONFIG.beforeHeading}</div>
        <p className={styles.note}>{WHY_CONFIG.beforeNote}</p>
        {before.length === 0 ? (
          <p className={styles.empty}>{WHY_CONFIG.emptyBefore}</p>
        ) : (
          <ul className={styles.list} data-testid="tw-why-before">
            {before.map((b) => (
              <li key={b.id}>
                <NodeLink node={b} extra={<time className={styles.nodeTime} dateTime={b.createdAt}>{when(b.createdAt)}</time>} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

const Series: React.FC<{ why: WhyResult }> = ({ why }) => (
  <section className={styles.col} aria-labelledby="tw-why-series" data-testid="tw-why-series">
    <h4 className={styles.colHead} id="tw-why-series">
      {WHY_CONFIG.columns.series}
    </h4>
    <p className={styles.note}>{WHY_CONFIG.seriesNote}</p>
    {why.series.length === 0 ? (
      <p className={styles.empty}>{WHY_CONFIG.emptySeries}</p>
    ) : (
      <ol className={styles.series}>
        {why.series.map((s) => (
          <li key={s.id} className={cx(styles.seriesItem, s.isCurrent && styles.seriesCurrent)} aria-current={s.isCurrent ? 'true' : undefined}>
            <NodeLink node={s} extra={<time className={styles.nodeTime} dateTime={s.createdAt}>{when(s.createdAt)}</time>} />
          </li>
        ))}
      </ol>
    )}
  </section>
);

export const WhyView: React.FC<WhyViewProps> = ({ recordId, why, unavailable, isLoading, isError }) => {
  if (unavailable) {
    return <div className={styles.status} data-testid="tw-why">The why read is not available yet.</div>;
  }
  if (!recordId) {
    return <div className={styles.status} data-testid="tw-why">{WHY_CONFIG.noRecord}</div>;
  }
  if (isError) {
    return <div className={styles.status} data-testid="tw-why">That record could not be found in this project.</div>;
  }
  if (isLoading || !why) {
    return <div className={styles.status} data-testid="tw-why">Loading why…</div>;
  }
  return (
    <div className={styles.why} data-testid="tw-why">
      <Because why={why} />
      <Self why={why} />
      <Series why={why} />
    </div>
  );
};

export default WhyView;
