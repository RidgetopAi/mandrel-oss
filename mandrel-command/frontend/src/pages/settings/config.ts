/**
 * Settings configuration — the single, named home for every Settings-screen tunable
 * (house rule configs-not-hardcoded). The section rail, react-query staleness, the
 * password-strength requirement copy, the dormant-idle preset list, the notification
 * event catalog (with per-event availability), and the honest data-gap notes all live
 * here so the section parts stay declarative.
 *
 * DATA POLICY: a section wired to a live endpoint carries
 * `live: true`; a section with no backend yet carries `live: false` and renders an
 * honest, disabled "not yet available" affordance that NAMES the gap — never a faked
 * control, never a new backend endpoint (that's a separate task).
 */
import type { IconKey } from './icons';

/** A section in the left rail. `live` drives whether the panel is wired or honest-empty. */
export interface SettingsSection {
  id: string;
  label: string;
  icon: IconKey;
  /** true = every control wires to a real endpoint; false = honest not-yet-available. */
  live: boolean;
  /** Render the rail entry in the danger tint. */
  danger?: boolean;
}

export const SETTINGS_CONFIG = {
  // Settings hooks are mutations-only (no useQuery) — no staleTime tunable needed.
  /** The section shown first when the page mounts. */
  defaultSectionId: 'account',
} as const;

/**
 * The section rail. Order + labels mirror the locked mock
 * (docs/command-settings-mock.html). `live` is grounded against the real backend
 * routes (mandrel-command/backend/src/routes/users.ts + projects.ts):
 *   • account       → PUT /users/profile, POST /users/change-password, POST /users/revoke-sessions  (LIVE)
 *   • projects      → POST /projects/:id/set-primary, POST /projects/clear-primary                  (LIVE)
 *   • appearance    → PATCH /users/preferences {theme}                                              (LIVE)
 *   • danger        → DELETE /projects/:id                                                          (LIVE)
 *   • identity      → runtime-managed actor mode; NO Command config endpoint                        (honest)
 *   • notifications → chat alert prefs; NO backend endpoint                                     (honest)
 *   • tokens        → MCP bridge token rotate/read; NO backend endpoint                             (honest)
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'account', label: 'Account', icon: 'user', live: true },
  { id: 'projects', label: 'Projects', icon: 'cube', live: true },
  { id: 'identity', label: 'Actors & identity', icon: 'identity', live: false },
  { id: 'notifications', label: 'Notifications', icon: 'bell', live: false },
  { id: 'tokens', label: 'API & tokens', icon: 'key', live: false },
  { id: 'appearance', label: 'Appearance', icon: 'appearance', live: true },
  { id: 'danger', label: 'Danger zone', icon: 'warning', live: true, danger: true },
];

/**
 * Password-strength requirements, surfaced verbatim to the user in the change-password
 * modal. These MIRROR the backend validator (UserService.validatePasswordStrength);
 * the server is authoritative and re-checks, so this list is guidance only.
 */
export const PASSWORD_REQUIREMENTS = [
  'At least 8 characters',
  'One uppercase letter (A–Z)',
  'One lowercase letter (a–z)',
  'One number (0–9)',
  'One special character (!@#$%^&*…)',
] as const;

/**
 * The notification event catalog shown in the Notifications section (the mock's
 * "Alert on" checklist). Every entry is `available: false` today — there is no backend
 * endpoint that stores per-event alert preferences, so the whole section renders as an
 * honest, disabled affordance (data-gap policy). When a preferences endpoint ships, flip
 * `available` per event and wire a hook — no other change needed here.
 */
export const NOTIFICATION_EVENTS = [
  { id: 'commit_gates', label: 'Commit gates', available: false },
  { id: 'deploy_results', label: 'Deploy results', available: false },
  { id: 'host_vitals', label: 'Host vitals', available: false },
  { id: 'session_end', label: 'Every session end', available: false },
] as const;

/**
 * Honest data-gap copy — the exact "why this is disabled" sentence each not-yet-available
 * section shows. Named + centralized so the gap is described consistently (never a silent
 * dead control).
 */
export const DATA_GAPS = {
  identity:
    'Actor-mode session identity is managed by the Runtime, not from Command. These values are shown for reference and are not configurable here yet.',
  notifications:
    'Alerts already route to chat from the Runtime, but per-event notification preferences have no Command backend endpoint yet — so these controls are read-only for now.',
  tokens:
    'MCP bridge token rotation has no Command backend endpoint yet. Rotation is done from the server; this panel will wire up when the endpoint ships.',
} as const;

/**
 * Reference-only descriptors for the Actors & identity section. These describe the REAL,
 * locked actor-mode foundation (X-Actor-ID enforcement) but are NOT read from a live
 * endpoint — so they are rendered as clearly-labelled reference rows, never editable
 * controls presenting fabricated live state (data-gap policy).
 */
export const IDENTITY_REFERENCE = [
  {
    id: 'resolver',
    label: 'Session resolver mode',
    detail: 'Sessions are keyed by actor × project, not by connection — a restart re-attaches.',
    value: 'Actor',
  },
  {
    id: 'require_actor',
    label: 'Require actor header',
    detail: 'Header-less writes are rejected with a clear error naming the missing X-Actor-ID.',
    value: 'Enforced',
  },
] as const;
