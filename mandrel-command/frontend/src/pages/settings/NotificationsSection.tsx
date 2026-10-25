/**
 * Notifications section — HONEST NOT-YET-AVAILABLE (the data-gap policy).
 *
 * Alerts already route to chat from the Runtime, but there is NO Command backend
 * endpoint that stores per-event notification preferences. So the event checklist renders
 * as DISABLED affordances with a note naming the gap — never faked toggles that silently
 * do nothing. When a preferences endpoint ships, flip `available` in config + wire a hook.
 */
import React from 'react';
import { Alert, Checkbox } from '../../components/ui';
import { Group, Row } from './parts';
import { DATA_GAPS, NOTIFICATION_EVENTS } from './config';
import styles from './Settings.module.css';

export const NotificationsSection: React.FC = () => (
  <Group
    title="Notifications & alerts"
    description="Alerts route to chat from the Runtime."
  >
    <div className={styles.rowInset}>
      <Alert variant="info" title="Not yet configurable from Command">
        {DATA_GAPS.notifications}
      </Alert>
    </div>
    <Row label="Alert on" help="Which events push to you (managed by the Runtime for now).">
      <div className={styles.checks}>
        {NOTIFICATION_EVENTS.map((e) => (
          <Checkbox key={e.id} disabled aria-label={e.label}>
            {e.label}
          </Checkbox>
        ))}
      </div>
    </Row>
  </Group>
);

export default NotificationsSection;
