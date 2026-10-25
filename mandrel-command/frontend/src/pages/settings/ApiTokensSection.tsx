/**
 * API & tokens section — MIXED, honestly labelled (the data-gap policy).
 *
 *   • MCP bridge token rotate/read — NO Command backend endpoint yet → disabled control
 *     with a note naming the gap (never a fake "Rotate" button that no-ops).
 *   • Embeddings — a true, non-sensitive deployment FACT (local Transformers.js, on-box,
 *     zero cost). Shown as an informational badge, clearly a fixed fact, not a live read.
 */
import React from 'react';
import { Alert, Badge, Button } from '../../components/ui';
import { Group, Row } from './parts';
import { DATA_GAPS } from './config';
import { LockIcon, RotateIcon } from './icons';
import styles from './Settings.module.css';

export const ApiTokensSection: React.FC = () => (
  <Group
    title="API & tokens"
    description="The MCP bridge and workspace access."
  >
    <div className={styles.rowInset}>
      <Alert variant="info" title="Token rotation not yet available from Command">
        {DATA_GAPS.tokens}
      </Alert>
    </div>
    <Row
      label="MCP bridge token"
      help="Used by clients to reach this workspace over the bridge."
    >
      <Button variant="ghost" disabled iconLeft={<RotateIcon />}>
        Rotate
      </Button>
    </Row>
    <Row
      label="Embeddings"
      help="Local Transformers.js — zero cost, nothing leaves the box."
    >
      <Badge variant="blue">
        <span className={styles.badgeIcon}>
          <LockIcon />
        </span>
        local · on-box
      </Badge>
    </Row>
  </Group>
);

export default ApiTokensSection;
