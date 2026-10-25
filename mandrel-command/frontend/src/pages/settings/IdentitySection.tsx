/**
 * Actors & identity section — HONEST NOT-YET-CONFIGURABLE (the data-gap policy).
 *
 * The actor-mode session foundation (sessions keyed by actor × project, X-Actor-ID
 * enforced) is REAL and locked — but it is managed by the Runtime, and Command has no
 * endpoint to read or configure it. So this section renders REFERENCE rows (clearly
 * labelled, non-editable) plus a note that names the gap — it never presents fabricated
 * live values as editable state, and never fakes a control.
 */
import React from 'react';
import { Alert, Badge } from '../../components/ui';
import { Group, Row } from './parts';
import { DATA_GAPS, IDENTITY_REFERENCE } from './config';
import styles from './Settings.module.css';

export const IdentitySection: React.FC = () => (
  <Group
    title="Session identity"
    description="How Mandrel resolves who is writing — the actor-mode foundation."
  >
    <div className={styles.rowInset}>
      <Alert variant="info" title="Managed by the Runtime">
        {DATA_GAPS.identity}
      </Alert>
    </div>
    {IDENTITY_REFERENCE.map((r) => (
      <Row key={r.id} label={r.label} help={r.detail}>
        <Badge variant="neutral">{r.value}</Badge>
      </Row>
    ))}
  </Group>
);

export default IdentitySection;
