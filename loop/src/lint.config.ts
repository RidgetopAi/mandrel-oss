/** Authoring-rule tunables for `lint`. Each is a named list; edit here, not in lint.ts. */

/** Container and service-manager tool names a clause must not depend on (matched as whole words, case-insensitive). */
export const DEFAULT_BANNED_WORDS: readonly string[] = [
  'docker',
  'docker-compose',
  'podman',
  'kubectl',
  'helm',
  'systemctl',
  'systemd',
  'journalctl',
  'launchctl',
  'supervisord',
  'supervisorctl',
  'pm2',
];

/** Top-level directories that mark an absolute filesystem path inside clause text. */
export const ROOTED_PATH_ROOTS: readonly string[] = [
  'home', 'usr', 'etc', 'var', 'opt', 'root', 'tmp', 'srv', 'mnt', 'bin', 'sbin', 'lib', 'dev', 'proc', 'sys', 'Users', 'private',
];

/** Phrases describing HOW a process was run rather than WHAT is true (matched case-insensitively). */
export const PROCESS_CLAIM_PHRASES: readonly string[] = [
  'in the foreground',
  'in the background',
  'before any',
  'started from',
  'started with',
  'launched from',
  'was run from',
  'as a daemon',
];

export interface LintConfig {
  bannedWords: readonly string[];
  rootedPathRoots: readonly string[];
  processClaimPhrases: readonly string[];
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  bannedWords: DEFAULT_BANNED_WORDS,
  rootedPathRoots: ROOTED_PATH_ROOTS,
  processClaimPhrases: PROCESS_CLAIM_PHRASES,
};
