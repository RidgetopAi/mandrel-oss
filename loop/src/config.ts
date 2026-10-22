/** Named configuration for the loop. Nothing in src/ hardcodes these values elsewhere. */

/** The punch contract as the loop understands it; pinned to mcp-server's by the golden file. */
export const TASK_STAGES = [
  'draft',
  'ready',
  'claimed',
  'verifying',
  'evidence',
  'merged',
  'deployed',
] as const;
export const PUNCH_PROOF_KINDS = ['test', 'browser', 'look'] as const;
export const PUNCH_CLAUSE_OWNERS = ['lane', 'human'] as const;

/** The stage the pick rule draws candidates from. */
export const PICKABLE_STAGE = 'ready' satisfies (typeof TASK_STAGES)[number];

/** Tag marking work that needs a human at the gate; the loop never picks it. */
export const RISK_GATE_TAG = 'risk:gate';
/** Tag the loop sets on a task it has given up on. */
export const LOOP_EXHAUSTED_TAG = 'loop:exhausted';

/** Clause owner that must carry a `proof`. */
export const PROOF_REQUIRED_OWNER = 'lane' satisfies (typeof PUNCH_CLAUSE_OWNERS)[number];

/** Highest rank first. */
export const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'] as const;

/** Task statuses that count as closed for `dependsOn` resolution. */
export const CLOSED_STATUSES = ['completed', 'cancelled'] as const;

/**
 * Claims on loop-owned stages. The server claims only from `todo` unless told otherwise, yet a task
 * in `claimed`, `verifying` or `evidence` is `in_progress` (the stage forces it), so a claim there
 * must widen `allowedStatuses` or it is refused `wrong-status`.
 */
export const CLAIM_CONFIG = {
  ownedStages: ['claimed', 'verifying', 'evidence'] as readonly string[],
  ownedStageStatuses: ['todo', 'in_progress'] as readonly string[],
} as const;

/** The `allowedStatuses` a claim on a task at `stage` must send; undefined means the server default. */
export function claimStatusesFor(stage: string): readonly string[] | undefined {
  return CLAIM_CONFIG.ownedStages.includes(stage) ? CLAIM_CONFIG.ownedStageStatuses : undefined;
}

/** Punch keys the server never accepts from a caller; they are re-sent only by the server itself. */
export const SERVER_MIRRORED_PUNCH_KEYS: readonly string[] = ['dependsOn'];

/** One Mandrel tool call on the gateway surface: the gateway tool and its `action` discriminator. */
export interface GatewayCall {
  readonly tool: string;
  readonly action: string;
}

/**
 * The Mandrel adapter speaks MCP over the streamable HTTP endpoint (`<mandrel.url>/mcp`), the one
 * endpoint every Mandrel serves, hosted or self-hosted. Board operations are gateway calls.
 */
export const MCP_CONFIG = {
  /** Appended to `mandrel.url`; a url that already ends in it is used as is. */
  endpointPath: '/mcp',
  headers: {
    connectionId: 'X-Connection-ID',
    actorId: 'X-Actor-ID',
    project: 'X-Mandrel-Project',
  },
  /** `clientInfo.name` sent on initialize (the version is loop/package.json's). */
  clientName: 'mandrel-loop',
  /** The gateway call behind each Board operation. */
  calls: {
    listProjects: { tool: 'project', action: 'list' },
    listTasks: { tool: 'task', action: 'list' },
    getTask: { tool: 'task', action: 'details' },
    claim: { tool: 'task', action: 'claim' },
    renew: { tool: 'task', action: 'renew' },
    release: { tool: 'task', action: 'release' },
    update: { tool: 'task', action: 'update' },
    create: { tool: 'task', action: 'create' },
  } satisfies Record<string, GatewayCall>,
  /** Page size for task list (server max is 100). */
  listPageSize: 100,
  /** Projects listed when doctor names the ones that exist (server max is 100). */
  projectListLimit: 100,
  /** Every request (initialize included) fails after this long instead of hanging. */
  requestTimeoutMs: 60_000,
  /** Ending a session (DELETE) is best effort and never waits longer than this. */
  closeTimeoutMs: 5_000,
  /** HTTP status a server answers for a session id it no longer holds; the client re-initializes. */
  sessionExpiredStatus: 404,
  /** HTTP statuses meaning the token was refused. */
  authFailureStatuses: [401, 403],
  /** Server text marking a 403 as a Host-header refusal (DNS-rebinding protection), not a token one. */
  hostRefusedText: 'Invalid Host header',
  /** HTTP statuses on initialize meaning no MCP endpoint lives at the URL (wrong path, a proxy, another app). */
  noEndpointStatuses: [400, 404, 405],
  /** Longest server-supplied text (error body, tool error) kept in an error message, after redaction. */
  serverTextMaxChars: 300,
  /** A bearer credential in server-supplied text; redacted wherever it appears. */
  bearerPattern: /Bearer\s+[^\s"',;)]+/gi,
  /** Re-initializations allowed for one call after its session expired. */
  sessionRetries: 1,
  /**
   * Socket-level failures meaning the server (or a middlebox) closed a pooled connection the caller
   * did not know was dead; an idempotent request is retried on them. An HTTP error response never is.
   */
  retryableSocketCodes: ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ECONNABORTED'],
  /** Retries of an idempotent request after a retryable socket failure. */
  socketRetries: 1,
} as const;

/** Literal a clause proof may carry instead of a repo-relative path. */
export const PROOF_WALKTHROUGH_LITERAL = 'walkthrough evidence (not committed to the repo)';

/** Provenance stamped on every punch the planner creates. */
export const PUNCH_SOURCE_MACHINE = 'machine';
/** The stage `plan --apply` creates punches in. */
export const APPLY_STAGE = 'draft' satisfies (typeof TASK_STAGES)[number];
/** Tag namespace carrying the repository a punch belongs to. */
export const REPO_TAG_PREFIX = 'repo:';
/** Tag namespace carrying a punch's size. */
export const SIZE_TAG_PREFIX = 'size:';
/** Sizes the planner may assign. */
export const PUNCH_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;

/** `claude` JSON output: every plan/worker/critic run asks for it so the run reports its cost. */
export const CLAUDE_RUN_CONFIG = {
  outputFormatFlag: '--output-format',
  outputFormat: 'json',
  /** Fields of the JSON result the loop reads. */
  resultKey: 'result',
  costKey: 'total_cost_usd',
  resultType: 'result',
  /** Per-run log line: `<logPrefix> role=<role> punch=<id> cost=$<usd>`. */
  logPrefix: 'claude run:',
  unknownCost: 'unreported',
  costDecimals: 4,
  /** Role names in the per-run line. */
  roles: { plan: 'plan', worker: 'worker', critic: 'critic' },
  /** Punch id shown for a run that serves no punch (plan). */
  noPunch: '-',
} as const;

/** `plan`: how the claude binary is run and where the planner card lives. */
export const PLAN_CONFIG = {
  /** Env var naming the claude binary; falls back to `defaultBin`. */
  binEnv: 'MANDREL_LOOP_CLAUDE_BIN',
  defaultBin: 'claude',
  /** Arguments placed before the prompt, which is fed on stdin. */
  args: ['-p', CLAUDE_RUN_CONFIG.outputFormatFlag, CLAUDE_RUN_CONFIG.outputFormat],
  /** Planner card, relative to the package root (loop/). */
  cardPath: 'cards/planner.md',
  /** Default output file for `plan`. */
  defaultOutput: 'punches.json',
  timeoutMs: 15 * 60 * 1000,
  maxBufferBytes: 32 * 1024 * 1024,
} as const;

/** Merge modes the loop supports. The ONLY
 * place the mode names are spelled; the first entry is the default. `rebase` is deliberately absent. */
export const MERGE_MODES = ['pr', 'direct'] as const;

/** `mandrel-loop.config.json`: defaults and file locations. */
export const CONFIG_DEFAULTS = {
  fileName: 'mandrel-loop.config.json',
  tokenEnv: 'MANDREL_TOKEN',
  actor: 'loop',
  repoMain: 'main',
  repoRemote: 'origin',
  gateTimeoutMinutes: 30,
  lanes: 1,
  tickSeconds: 300,
  mergeMode: MERGE_MODES[0],
  workerTimeoutMinutes: 45,
  workerMaxAttempts: 2,
  workerPermissionMode: 'bypassPermissions',
  workerAllowRoot: false,
  /** The critic must run node/npm to measure; it defaults to the worker's mode. */
  criticPermissionMode: 'bypassPermissions',
  criticMaxAttempts: 2,
  criticAllowSameModel: false,
  /** Directory name under the user's home. */
  workdirName: '.mandrel-loop',
} as const;

/** Credentials the worker and `gh` may use, by NAME. Values are never read into output. */
export const AUTH_CONFIG = {
  /** Worker credential env names, in report order. */
  workerEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  /** Claude Code credentials file, relative to HOME (existence only). */
  workerCredentialsFile: ['.claude', '.credentials.json'],
  ghTokenEnv: 'GH_TOKEN',
  ghBin: 'gh',
  ghAuthArgs: ['auth', 'status'],
  /** Always passed to child processes when present in the parent. */
  childEnvBase: ['PATH', 'HOME', 'LANG'],
  /** Exit code for refusals (missing auth, root). */
  refusalExit: 2,
} as const;

/** `worker`: branch/worktree naming, brief location, and git/process limits. */
export const WORKER_CONFIG = {
  branchPrefix: 'loop/',
  /** Characters of the id shown in the branch name. */
  idLength: 8,
  slugMaxLength: 40,
  slugFallback: 'punch',
  /** Worktrees live under `<workdir>/<worktreeDir>/<id8>-<slug>`. */
  worktreeDir: 'worktrees',
  /** Worker brief, relative to the package root (loop/). */
  cardPath: 'cards/worker.md',
  /** Arguments around the permission mode / model; the brief is fed on stdin. */
  args: { print: '-p', permissionMode: '--permission-mode', outputFormat: '--output-format', outputValue: CLAUDE_RUN_CONFIG.outputFormat, model: '--model' },
  /** How often the claim lease is renewed while the worker runs. */
  renewEveryMs: 5 * 60 * 1000,
  /** Output kept (tail) for failure notes. */
  noteTailChars: 600,
  maxBufferBytes: 32 * 1024 * 1024,
  gitTimeoutMs: 2 * 60 * 1000,
  /** Grace between SIGTERM and SIGKILL on timeout. */
  killGraceMs: 5000,
} as const;

/** The merger: how a verified punch reaches main. */
export const MERGER_CONFIG = {
  /** `pr` opens a pull request and waits for it to merge; `direct` gates and merges locally. */
  defaultMode: CONFIG_DEFAULTS.mergeMode,
  modes: MERGE_MODES,
  /** Env var naming the gh binary; falls back to `defaultGhBin`. */
  ghBinEnv: 'MANDREL_LOOP_GH_BIN',
  defaultGhBin: 'gh',
  defaultRemote: 'origin',
  defaultMainBranch: 'main',
  /** Direct mode: the repo's gate command (run through bash -c) and its time limit. */
  defaultGateCommand: 'bash scripts/oss-gate.sh',
  gateTimeoutMs: 30 * 60 * 1000,
  /** Lines of gate output kept as the note when the gate is RED. */
  gateTailLines: 40,
  maxBufferBytes: 32 * 1024 * 1024,
  /** Gate exit codes (the repo's verdict namespace). */
  gateExit: { green: 0, red: 1, couldNotMeasure: 2 },
  /** The walkthrough verdict value that allows a merge. */
  passVerdict: 'PASS',
  /** The `gh pr view` state that means the PR was merged. */
  prMergedState: 'MERGED',
  /** Stage a punch returns to when its branch moved after the verdict. */
  restageOnStale: 'verifying',
  /** Stage a punch returns to when the gate says RED. */
  restageOnRed: 'ready',
  /** Stage a merged punch lands in. */
  mergedStage: 'merged',
  /** Matches the PR number at the end of a PR url. */
  prUrlPattern: /\/pull\/(\d+)\s*$/,
} as const;

/** Verdicts the critic may return; the stage each one leaves the punch at is in `CRITIC_CONFIG.stageFor`. */
/** Values `claude --permission-mode` accepts; shared by `worker.permissionMode` and `critic.permissionMode`. */
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const;

export const CRITIC_VERDICTS = ['PASS', 'FAIL', 'COULD-NOT-MEASURE', 'CONTRACT-DEFECT'] as const;

/** `critic`: how the independent verifier is run and where its output is read from. */
export const CRITIC_CONFIG = {
  /** Critic card, relative to the package root (loop/). */
  cardPath: 'cards/walkthrough.md',
  /** Arguments placed before `--model <models.critic>`; the prompt is fed on stdin. */
  args: ['-p', CLAUDE_RUN_CONFIG.outputFormatFlag, CLAUDE_RUN_CONFIG.outputFormat],
  permissionModeFlag: '--permission-mode',
  modelFlag: '--model',
  /** Source of record, inside the evidence directory. */
  verdictFile: 'verdict.json',
  /** Fallback: the last stdout line starting with this marker, followed by the verdict JSON. */
  verdictMarker: 'MANDREL-LOOP-VERDICT:',
  /** Env var through which the critic is told its evidence directory. */
  evidenceEnv: 'MANDREL_LOOP_EVIDENCE_DIR',
  /** A clause containing this text needs a red and a green run per named mutation. */
  mutationClauseText: 'Critic applies and shows RED',
  /** Layout under the workdir: `<workdir>/<dir>/<task id8>/{tree,evidence}`. */
  dir: 'critic',
  treeDir: 'tree',
  evidenceDir: 'evidence',
  idPrefixLength: 8,
  timeoutMs: 30 * 60 * 1000,
  maxBufferBytes: 32 * 1024 * 1024,
  /** Punch keys the critic reads (branch/sha/base) and writes (walkthrough, failures). */
  punchKeys: { branch: 'branch', sha: 'sha', base: 'base', walkthrough: 'walkthrough', failures: 'walkthroughFailures' },
  /** Stage a punch is left at, per verdict. */
  stageFor: {
    PASS: 'evidence',
    FAIL: 'ready',
    'COULD-NOT-MEASURE': 'verifying',
    'CONTRACT-DEFECT': 'draft',
  },
} as const satisfies Record<string, unknown>;

/** `tick`: how one sweep behaves and when the loop gives up. */
export const TICK_CONFIG = {
  /** Consecutive not-started worker outcomes after which the loop stops. */
  maxConsecutiveNotStarted: 3,
  /** Exit code when the loop stops for that reason. */
  haltExit: 3,
  /** `ready <id>` moves a punch from `readyFromStage` to `promotedStage`. */
  readyFromStage: 'draft',
  /** Stage a claimed punch is moved to when its worker is dispatched. */
  claimedStage: 'claimed',
  /** Stage a punch returns to when its lease lapsed or its worker never started. */
  releasedStage: 'ready',
  /** Stage whose punches are promoted once every `dependsOn` has closed. */
  promoteFromStage: 'draft',
  promotedStage: 'ready',
  /** A draft carrying this punch key has been worked before and is never auto-promoted. */
  workedPunchKey: 'lane',
  /** Punch keys the worker writes (`lane`) and the critic and merger read. */
  bridge: { lane: 'lane', branch: 'branch', sha: 'sha', verdict: 'verdict' },
} as const;

/** `notify`: the transition record and the optional webhook. */
export const NOTIFY_CONFIG = {
  event: 'transition',
  /** Emitted when the board refuses a claim, so a swallowed refusal is still visible. */
  claimRefusedEvent: 'claim-refused',
  webhookTimeoutMs: 10_000,
  webhookHeaders: { 'content-type': 'application/json' },
} as const;

/** `service --print`: user-level service definitions. */
export const SERVICE_CONFIG = {
  targets: ['linux', 'macos'],
  command: 'mandrel-loop',
  subcommand: 'run',
  linux: {
    unitDescription: 'Mandrel Punch List loop',
    /** Optional (leading "-") environment file holding the token variables, relative to the user's home. */
    environmentFile: '%h/.config/mandrel-loop/env',
    restartSec: 30,
    wantedBy: 'default.target',
  },
  macos: {
    label: 'dev.mandrel.loop',
    logPath: '/tmp/mandrel-loop.log',
  },
} as const;

/** `doctor` live checks: what actually breaks a run, beyond credentials being present. */
export const DOCTOR_CONFIG = {
  /** Project names a failed project check lists before summarising the rest as "and N more". */
  projectHintLimit: 10,
  /** Stage listed (project-scoped) to prove the configured project exists. */
  projectProbeStage: 'ready' satisfies (typeof TASK_STAGES)[number],
  /**
   * A task id that exists nowhere (nil UUID). Doctor tries to claim it: a server with claims off
   * refuses `disabled` before it looks the task up, while a server with claims on refuses
   * `not-found`. No real task is ever touched, so no claim is left held.
   */
  claimProbeTaskId: '00000000-0000-0000-0000-000000000000',
  /** The refusal reason a server with claims switched off answers with. */
  claimsDisabledReason: 'disabled',
  /** The server setting that turns claims on, named in the doctor failure. */
  claimsEnvVar: 'MANDREL_TASK_CLAIM_ENABLED',
  /** A tool error meaning the server has no such tool: a Mandrel older than the gateway tools. */
  unknownToolPatterns: [/unknown tool/i, /no validation schema found for tool/i],
  gitBin: 'git',
  gitTimeoutMs: 30 * 1000,
  /** Added to git's environment so a credential prompt fails fast instead of hanging doctor. */
  gitEnv: { GIT_TERMINAL_PROMPT: '0' },
  /** Git identity keys a commit needs. */
  identityKeys: ['user.name', 'user.email'],
} as const;
