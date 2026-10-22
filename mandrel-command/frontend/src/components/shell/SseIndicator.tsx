/**
 * The topbar connectivity indicator (P0.4) — token-driven, reading SseContext AND
 * the react-query cache.
 *
 * ── WHAT IT USED TO SAY, AND WHY THAT WAS WRONG ──────────────────────
 * The operator, 2026-08-08: he was disconnected from the Command UI and the only sign was this
 * indicator. He nearly missed it — and he built the thing. Two measured causes:
 *
 * 1. IT REPORTED THE WRONG THING. It keyed off `useSseContext().isConnected` — SSE
 *    liveness ONLY — with no relation to whether API reads were succeeding. A failing
 *    `/api/projects` under a healthy SSE stream still showed a green "Live" while the
 *    page could not read anything. It now ALSO watches the query cache for reads that
 *    got no answer from the server at all, and that state outranks the SSE one.
 *
 * 2. ON MOBILE IT WAS LITERALLY ONLY A DOT. `Topbar.module.css` hid `.sseLabel` below
 *    600px, and the `title=` tooltip does not exist on touch — so on the operator's primary
 *    device the entire signal was an unlabelled coloured dot. The label is still hidden
 *    below 600px when everything is HEALTHY (topbar space is scarce), and is FORCED BACK
 *    ON whenever the state is degraded, via `data-degraded`. A degraded state also gets a
 *    tinted chip so it reads as a warning and not as decoration.
 *
 * ── WHY "no answer from the server" AND NOT "any query error" ────────────────────────
 * The shared axios interceptor (services/api.ts) rejects with an `ApiError` whose
 * `status` is `error.response?.status ?? 0` — so 0 means the request produced NO HTTP
 * response: DNS, TCP, TLS, a dead backend, a lost network. A 404 or a 500 is a live
 * server answering, and must NOT paint the topbar red; that is a page-level error, and
 * the pages own it. This is C1's third state given its own branch: "could not reach the
 * server" is neither "fine" nor "the server said no".
 */
import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSseContext } from '../../contexts/SseContext';
import styles from './Topbar.module.css';

/**
 * True for a rejection that never got an HTTP response — `ApiError.status === 0` from
 * the shared interceptor. Duck-typed on the field, never on a class: two rejection
 * shapes reach the cache (the interceptor's object literal and a real `Error` from
 * `unwrapData`), and only the former can carry a status. See api/request.ts.
 */
export function isUnreachableError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  return (err as { status?: unknown }).status === 0;
}

/** True when any query in the cache currently sits on an unreachable-server error. */
function anyReadUnreachable(queries: Array<{ state: { error: unknown } }>): boolean {
  return queries.some((q) => isUnreachableError(q.state.error));
}

interface IndicatorState {
  tone: string;
  label: string;
  title: string;
  degraded: boolean;
}

/**
 * The single place the three inputs become one displayed state, exported so a test can
 * drive every combination without a DOM. Order is a PRECEDENCE, not a preference:
 * unreachable reads are the worst thing we know and must not be masked by a healthy SSE
 * stream (that masking was cause 1 above).
 */
export function indicatorState(input: {
  apiUnreachable: boolean;
  isConnected: boolean;
  isSupported: boolean;
}): IndicatorState {
  if (input.apiUnreachable) {
    return {
      tone: styles.dotCrit,
      label: 'Offline',
      title: "Can't reach the server — what you see may be stale or incomplete",
      degraded: true,
    };
  }
  if (!input.isSupported) {
    return {
      tone: styles.dotWarn,
      label: 'Polling',
      title: 'Realtime unsupported here — updates arrive on a poll',
      degraded: true,
    };
  }
  if (!input.isConnected) {
    return {
      tone: styles.dotWarn,
      // NOT "Offline": reads are working, only the live stream dropped. Saying
      // "Offline" here is the same over-wide claim as saying "Live" during an outage.
      label: 'Not live',
      title: 'Realtime updates disconnected — this page has stopped updating itself',
      degraded: true,
    };
  }
  return { tone: styles.dotOk, label: 'Live', title: 'Realtime: Live', degraded: false };
}

export const SseIndicator: React.FC = () => {
  const { isConnected, isSupported } = useSseContext();
  const queryClient = useQueryClient();
  const [apiUnreachable, setApiUnreachable] = React.useState(false);

  React.useEffect(() => {
    const cache = queryClient.getQueryCache();
    const read = () => setApiUnreachable(anyReadUnreachable(cache.getAll()));
    read();
    return cache.subscribe(read);
  }, [queryClient]);

  const { tone, label, title, degraded } = indicatorState({
    apiUnreachable,
    isConnected,
    isSupported,
  });

  return (
    <span
      className={styles.sse}
      role="status"
      aria-live="polite"
      // The tooltip is a bonus for pointer devices; the visible label is the signal.
      title={title}
      // Read by the mobile media query to keep the label on screen when it matters,
      // and by the chip styling. An attribute rather than a second class so the CSS
      // rule states the CONDITION it cares about.
      data-degraded={degraded ? 'true' : 'false'}
    >
      <span className={`${styles.dot} ${tone}`} aria-hidden="true" />
      <span className={styles.sseLabel}>{label}</span>
    </span>
  );
};

export default SseIndicator;
