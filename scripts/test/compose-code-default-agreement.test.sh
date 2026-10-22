#!/usr/bin/env bash
# =============================================================================
# compose-code-default-agreement.test.sh
# -----------------------------------------------------------------------------
# Guards a DIFFERENT property from its sibling compose-flag-declarations suite.
#
#   sibling  : "is this flag DECLARED in the tracked base compose, and does the
#              declaration still render the value we pinned by hand?"
#   this file: "does that declared default AGREE WITH THE CODE that reads the
#              variable?" — i.e. is the number in the YAML the same number the
#              program falls back to when the variable is absent?
#
# THE CLASS THIS GUARDS
# ---------------------
# Every wire-only declaration in docker-compose.yml carries the same promise, written
# out in its comment: "the default MIRRORS the code default, so this ships the WIRE,
# not a flip." That promise is PROSE. Nothing checked it. The two sides can be edited
# months apart by different people:
#   * someone hardens a code default (fail-closed) and the compose file keeps handing
#     every container the old permissive value — the hardening never reaches the fleet;
#   * someone edits a compose default "to match the code" from memory and silently
#     changes fleet behaviour on the next `docker compose up`;
#   * a var is read in TWO programs (mcp-server + the Command backend) whose defaults
#     drift apart, and only one service's declaration gets updated.
# In all three the deploy is green and the operator's mental model is wrong. That is
# the same shape as the defect this whole workstream exists for: a value that is right
# in the code and wrong in the deployment.
#
# THE POPULATION — STATED, because a guard's own scope is the thing authors forget
# (CLASSES.md C3). This test enumerates:
#   * the TRACKED BASE docker-compose.yml only,
#   * every service that has an `environment:` block (not just mcp-server),
#   * every value of the exact shape `${VAR:-default}` in those blocks.
# That is the choke point a fleet-wide default must pass through. Every member of that
# population MUST have exactly one row in DEFAULT_CONTRACT below, and every row must
# correspond to a live declaration — so the set is a PROPERTY OF THE ARTIFACT, not a
# curated opinion. A new defaulted declaration with no row is a loud RED; a row whose
# declaration was deleted is a loud RED.
#
# WHAT THIS PARSER DOES **NOT** MATCH — the blind spots, named rather than papered over:
#   1. `${VAR}` with NO default, and `${VAR:?err}` (required-or-die). They declare no
#      default, so there is nothing to contradict. POSTGRES_PASSWORD is the live example.
#   2. A BARE LITERAL declaration (`MANDREL_FOO: "false"`, no `${...}`). Unconscripted on
#      purpose — the same shape is how genuinely fixed infrastructure is declared
#      (NODE_ENV, MCP_HTTP_PORT, REDIS_HOST) and conscripting those would recreate a
#      curated allow-list. A literal that SHOULD have been a flag is invisible here.
#   3. Nested/derived interpolation (`${A:-${B:-x}}`), and a default containing `}`.
#      The extractor takes the whole remainder to the final `}`; a nested form would be
#      compared verbatim and almost certainly go RED rather than silently pass — but it
#      has never been used here and is not designed for.
#   4. `env_file:` / `--env-file` values, and the gitignored PER-TENANT OVERLAYS
#      (docker-compose.<handle>.yml). Not in the repo; invisible by construction. This
#      is the biggest hole and it is the reason the base declaration must exist at all.
#   5. Anything OUTSIDE compose: a non-compose deployment's env file carries its
#      own values and is not a file in this repo.
#   6. On the CODE side the extraction is per-row REGEX, not a TypeScript parse. A var
#      read through an indirection this file's row does not name — a helper, a computed
#      key, a second reader in another module — is not seen. The mitigation is that a
#      regex which stops matching FAILS CLOSED (section 3 reds on "no match"), so a
#      refactor that moves the default breaks this test loudly instead of quietly.
#      It also means a SECOND reader of the same var with a DIFFERENT default is only
#      caught if a row names it (MANDREL_EMBEDDER has two rows for exactly this reason).
#   7. A code default that is DERIVED at runtime rather than written as a literal
#      (AIDIS_LOCK_FILE -> path.join(process.cwd(), …)) cannot be compared at all. Those
#      are EXEMPT rows and each carries a written reason.
#
# THE GUARD GUARDS ITSELF (CLASSES.md C3)
# ---------------------------------------
# Section 4 is a permanent MUTATION PROBE. It mutates the COMPOSE side and the CODE side
# on throwaway copies and asserts the checker goes RED for each, with the unmutated
# control GREEN — including the empty-population case (a compose file with no defaulted
# declarations at all must NOT be reported as a pass).
#
# USAGE:  bash scripts/test/compose-code-default-agreement.test.sh
# =============================================================================
set -uo pipefail

REPO_DIR_REAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_DIR_REAL/docker-compose.yml"
CHECKER="$(mktemp "${TMPDIR:-/tmp}/compose-code-default-checker.XXXXXX.py")"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
PASS=0; FAIL=0
pass() { printf '  %s[PASS]%s %s\n' "$GRN" "$RST" "$*"; PASS=$((PASS+1)); }
fail() { printf '  %s[FAIL]%s %s\n' "$RED" "$RST" "$*"; FAIL=$((FAIL+1)); }
hdr()  { printf '\n%s== %s ==%s\n' "$BLD" "$*" "$RST"; }

cleanup() { rm -f "$CHECKER"; [[ -n "${TMPD:-}" ]] && rm -rf "$TMPD"; }
trap cleanup EXIT
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/compose-code-default.XXXXXX")"

# -----------------------------------------------------------------------------
# FAIL CLOSED on a missing parser. The consumer of docker-compose.yml is an
# interpreter, so the reader here must be a real YAML parser and never a grep
# (a grep passes on a commented-out line and on a declaration under the wrong
# service). If PyYAML is absent we FAIL rather than skip — same posture as the
# sibling test and as the CI gate's gitleaks stage.
# -----------------------------------------------------------------------------
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
  printf '%sFATAL: python3 + PyYAML is required (this test parses YAML; it must never degrade to a grep).%s\n' "$RED" "$RST" >&2
  exit 1
fi
[[ -r "$COMPOSE_FILE" ]] || { printf '%sFATAL: %s not readable.%s\n' "$RED" "$COMPOSE_FILE" "$RST" >&2; exit 1; }

# =============================================================================
# THE CONTRACT TABLE
# -----------------------------------------------------------------------------
# One row per defaulted declaration in the base compose. Fields are TAB-free and
# TILDE-delimited (`~`, not `|`: the extraction regexes contain `|` for
# alternation and `\|\|` for a JS `||`, so a pipe delimiter would split them):
#
#   <service>~<KEY>~<VAR>~<KIND>~<code file>~<extraction regex>~<expected/reason>
#
# KIND is one of:
#
#   CODE        The variable has a literal code default. The regex must match in
#               <code file> and its ONE capture group is the code default; it MUST
#               EQUAL the compose default. This is the normal, healthy row.
#
#   DIVERGES    The two sides deliberately DISAGREE. The regex still runs and its
#               capture MUST EQUAL <expected>, and <expected> must NOT equal the
#               compose default — so the divergence is pinned from BOTH ends. If
#               someone changes either side the row goes RED and a human has to
#               re-justify it. This is an explicit, commented, listed exception —
#               never a silent skip. Every DIVERGES row states WHY in its comment.
#
#   PASSTHROUGH The compose default is EMPTY, which for these readers is
#               behaviourally identical to unset (envStr/envBool/envList fold ''
#               into the fallback), so the code's own — often derived — default
#               still applies and cannot be contradicted. Asserted: the compose
#               default really IS empty. Put a real value there and the row goes
#               RED, forcing a reclassification to CODE or DIVERGES.
#
#   EXEMPT      No comparable literal code default exists (the reader throws, or
#               derives the value at runtime, or the consumer is not our code at
#               all). Requires a written reason. This is the honest hole; keep it
#               small and keep the reasons specific.
#
# Regexes are Python `re`, matched against the file's full text, and must contain
# exactly ONE capture group. ZERO matches is a RED (fail closed) — a refactor that
# moves a default breaks this test loudly instead of quietly.
# =============================================================================
DEFAULT_CONTRACT=(
  # --- postgres --------------------------------------------------------------
  # Consumed by the upstream postgres image's entrypoint, not by any code in this
  # repo, so there is no code default to agree with. The compose file IS the source.
  "postgres~POSTGRES_DB~POSTGRES_DB~EXEMPT~~~consumed by the upstream postgres image entrypoint; no reader in this repo"
  "postgres~POSTGRES_USER~POSTGRES_USER~EXEMPT~~~consumed by the upstream postgres image entrypoint; no reader in this repo"

  # --- mcp-server ------------------------------------------------------------
  # DATABASE_NAME has NO code default: config/database.ts throws when it is unset.
  # That is stricter than a default and cannot be compared to one.
  "mcp-server~DATABASE_NAME~POSTGRES_DB~EXEMPT~~~mcp-server/src/config/database.ts:113-115 THROWS when unset — no default to mirror"
  "mcp-server~DATABASE_USER~POSTGRES_USER~CODE~mcp-server/src/config/database.ts~process\\.env\\.DATABASE_USER \\|\\| '([^']*)'~"
  # SSL is parsed as a positive match on the string 'true', so ABSENT resolves to
  # off — which agrees with the compose 'false' — but there is no literal token in
  # the source to extract, so this cannot be a CODE row without inventing one.
  "mcp-server~DATABASE_SSL~DATABASE_SSL~EXEMPT~~~parsed as (… ?? '').toLowerCase()==='true' (databasePool.ts:88) — absent means off, but no literal default token exists to compare"
  "mcp-server~LOG_LEVEL~LOG_LEVEL~CODE~mcp-server/src/utils/logger.ts~process\\.env\\.LOG_LEVEL \\|\\| '([^']*)'~"
  # ---------------------------------------------------------------------------
  # READ THIS BEFORE DELETING THIS DECLARATION. It looks dead and is NOT.
  #
  # An earlier version of this row said "no reader exists anywhere in mcp-server/src —
  # the declaration is inert." That was WRONG, and it was wrong in the exact way this
  # whole file exists to catch: the sweep that produced it was scoped to `process.env`
  # reads in one directory, and the real consumer is not a `process.env` read at all.
  #
  # ⚠️ THE BOOT-CONTRACT HALF OF THIS NOTE WAS RETIRED ON 2026-08-26.
  # It used to read: DB_LOG_LEVEL is listed UNCOMMENTED at mcp-server/.env.example:27,
  # dotenv-safe (database.ts:56) requires every key in that file to be PRESENT in
  # process.env, and a missing one throws -> `NODE_ENV === 'production'` ->
  # process.exit(1) (database.ts:63-66). All of that machinery is still exactly true.
  # What changed is the premise: DB_LOG_LEVEL is no longer uncommented in that file,
  # so it is no longer in the required set and deleting the compose line can no longer
  # fail a boot. Re-derive rather than trusting this paragraph:
  #   node -e 'const d=require("./mcp-server/node_modules/dotenv"),f=require("fs");
  #            console.log(Object.keys(d.parse(f.readFileSync("mcp-server/.env.example"))))'
  # Measured 2026-08-26: 7 keys, DB_LOG_LEVEL not among them.
  #
  # WHY IT WAS DE-REQUIRED, because it is the sharper finding: DB_LOG_LEVEL is read by
  # NOTHING in the mcp-server package. `grep -rn DB_LOG_LEVEL mcp-server
  # --exclude-dir=node_modules --exclude-dir=dist` returned exactly ONE hit — the
  # .env.example line that made it boot-fatal. A key that controls nothing was able to
  # kill the container, purely because it was documented.
  #
  # THE EXEMPT STANDS, on its ORIGINAL and still-correct ground: there is genuinely no
  # code default to agree with, because nothing reads the value, so no literal exists
  # to compare the compose default to. The compose declaration is also unchanged and
  # deliberately so — it is harmless, and removing it is a separate decision from
  # removing its ability to abort a boot.
  # ---------------------------------------------------------------------------
  "mcp-server~DB_LOG_LEVEL~DB_LOG_LEVEL~EXEMPT~~~value is never read by ANY code in the package (1 grep hit, its own example line); de-required 2026-08-26 so it is no longer a boot contract either — no code literal exists to compare against"
  "mcp-server~COMMAND_BASE_URL~COMMAND_BASE_URL~PASSTHROUGH~~~empty is the point: commandUrlConfig.ts:95-106 then derives this instance's OWN origin from MCP_ALLOWED_HOSTS"
  # Fail-closed gate: the default is expressed as an early return, not a literal
  # argument. The regex pins that return value, which IS the default.
  "mcp-server~MCP_BRIDGE_AUTH_ENABLED~MCP_BRIDGE_AUTH_ENABLED~CODE~mcp-server/src/config/bridgeAuthConfig.ts~if \\(raw === undefined\\) return (true|false); // unset~"
  # DIVERGES, deliberately: the bundled install defaults claims ON because the
  # reference loop requires them; the code default stays false (dark) for bare-server callers.
  "mcp-server~MANDREL_TASK_CLAIM_ENABLED~MANDREL_TASK_CLAIM_ENABLED~DIVERGES~mcp-server/src/config/claimConfig.ts~envBool\\('MANDREL_TASK_CLAIM_ENABLED', *(true|false)\\)~false"
  "mcp-server~MANDREL_SESSION_RESOLVER_MODE~MANDREL_SESSION_RESOLVER_MODE~CODE~mcp-server/src/config/sessionConfig.ts~envEnum<ResolverMode>\\('MANDREL_SESSION_RESOLVER_MODE', *RESOLVER_MODES, *'([^']*)'\\)~"
  "mcp-server~MANDREL_SESSION_REQUIRE_ACTOR~MANDREL_SESSION_REQUIRE_ACTOR~CODE~mcp-server/src/config/sessionConfig.ts~envBool\\('MANDREL_SESSION_REQUIRE_ACTOR', *(true|false)\\)~"
  # ---------------------------------------------------------------------------
  # DIVERGES, deliberately (Reviewer ruling 2): the code default is
  # NODE_ENV==='production' — TRUE inside every fleet container — but tenants must not
  # page Operator's phone about their own quiet graphs (per-tenant alerting is future
  # work), so the base compose pins them OFF explicitly. Prod re-enables in
  # docker-compose.prod file ("true" + the notify delivery mounts). The regex pins the
  # code-side expression so a future literal-true default here reclassifies loudly.
  # ---------------------------------------------------------------------------
  "mcp-server~MANDREL_PROVENANCE_ALARM_ENABLED~MANDREL_PROVENANCE_ALARM_ENABLED~DIVERGES~mcp-server/src/config/provenanceConfig.ts~alarmEnabled: envBool\\('MANDREL_PROVENANCE_ALARM_ENABLED', (.*)\\),~process.env.NODE_ENV === 'production'"
  # SK5 branch-scoped briefing selection. The compose default and the code
  # default AGREE (both false), so this is a CODE row: the extracted literal must equal the
  # compose default, and the two move together or the guard goes RED.
  "mcp-server~MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED~MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED~CODE~mcp-server/src/config/briefingConfig.ts~envBool\\('MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED', ([a-z]*)\\)~"
  # P5.1 briefing render altitude. Compose true == briefingAltitudeConfig.ts true.
  "mcp-server~MANDREL_BRIEFING_ALTITUDE_ENABLED~MANDREL_BRIEFING_ALTITUDE_ENABLED~CODE~mcp-server/src/config/briefingAltitudeConfig.ts~envBool\\('MANDREL_BRIEFING_ALTITUDE_ENABLED', ([a-z]*)\\)~"
  # --- unattributed-write notice (attributionNoticeConfig.ts) ----------------
  # ENABLED is the only one of the six with an opinion in compose, and it is WIRE-ONLY:
  # compose true == the code default true, so declaring it changes no tenant's behaviour;
  # it exists so a tenant can turn the notice OFF from its env file.
  #
  # The CODE regex reaches the call site DIRECTLY — envBool('<literal name>', <default>) —
  # which is only possible because the name is a literal there. It was an
  # ATTRIBUTION_NOTICE_ENV.ENABLED indirection until STAGE 0a5 REDed it (merged ref
  # b381b98a); had it stayed, this row could not have been written as CODE at all and the
  # honest classification would have been EXEMPT, i.e. the hole. Two guards, one root cause.
  "mcp-server~MANDREL_ATTRIBUTION_NOTICE_ENABLED~MANDREL_ATTRIBUTION_NOTICE_ENABLED~CODE~mcp-server/src/config/attributionNoticeConfig.ts~envBool\\('MANDREL_ATTRIBUTION_NOTICE_ENABLED', ([a-z]*)\\)~"
  # The other five are empty passthroughs. envStr/envInt fold '' into the fallback
  # (attributionNoticeConfig.ts), which is exactly what docker-compose.prod file's inline
  # empty declarations depend on and what src/tests/attributionNotice.unit.test.ts asserts
  # by loading the module fresh with all six set to "" and comparing to all six absent.
  "mcp-server~MANDREL_ATTRIBUTION_SUGGESTED_ACTOR~MANDREL_ATTRIBUTION_SUGGESTED_ACTOR~PASSTHROUGH~~~empty is the point: a multi-user instance does not know the caller's name, so the code default (null) renders the honest <your-name> placeholder; a single-user tenant sets a real name in its env file"
  "mcp-server~MANDREL_ATTRIBUTION_NOTICE_SETUP_URL~MANDREL_ATTRIBUTION_NOTICE_SETUP_URL~PASSTHROUGH~~~empty so the customer-facing URL has ONE source (DEFAULT_ATTRIBUTION_SETUP_URL); a literal here would fork the link into two tracked files"
  "mcp-server~MANDREL_ATTRIBUTION_NOTICE_DEADLINE~MANDREL_ATTRIBUTION_NOTICE_DEADLINE~PASSTHROUGH~~~empty means NO deadline sentence is rendered at all; it gets a value in the same change that schedules MANDREL_SESSION_REQUIRE_ACTOR=true, never before"
  "mcp-server~MANDREL_ATTRIBUTION_NOTICE_TTL_MS~MANDREL_ATTRIBUTION_NOTICE_TTL_MS~PASSTHROUGH~~~empty so the code's 6h suppression window applies; envInt folds '' AND garbage into the fallback, so a bad value can never become a 0 TTL that fires on every write"
  "mcp-server~MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS~MANDREL_ATTRIBUTION_NOTICE_MAX_KEYS~PASSTHROUGH~~~empty so the code's 5000-key bound applies; the bound exists because the suppression map is keyed on a caller-supplied connection id in a process that runs for weeks"
  # ---------------------------------------------------------------------------
  # EXCEPTION RESOLVED 2026-07-30. This was the file's one deliberate
  # DIVERGES row: compose materialised `shadow` while the code default was `enforce`,
  # justified as a soak window. Operator approved enforcing, the soak ended, and the
  # declaration became a PASSTHROUGH — so there is no longer a divergence to justify
  # and the old justification is GONE rather than left standing. A stale rationale for
  # a resolved divergence is the drift this gate exists to kill.
  #
  # It is PASSTHROUGH and not CODE because compose now states no opinion at all: the
  # empty default renders an empty string, which callerIdentityConfig.ts:87 folds into
  # PROJECT_SCOPE_GUARD_DEFAULT (`enforce`). There is nothing for the code default to
  # agree or disagree WITH — which is the point of the change.
  #
  # THIS ROW IS WHAT STOPS THE REGRESSION. Put any literal back on this key —
  # `:-shadow`, or even `:-enforce` — and PASSTHROUGH goes RED, because a value here
  # once again pre-empts the code. Probe 4d below is that exact mutation.
  # ---------------------------------------------------------------------------
  "mcp-server~MANDREL_PROJECT_SCOPE_GUARD~MANDREL_PROJECT_SCOPE_GUARD~PASSTHROUGH~~~soak over, guard enforcing: compose states no opinion so the code's fail-closed default (enforce) is reached; empty->enforce proved in projectScopeGuardPassthrough.contract.test.ts"
  # Embedder selection — the wire added by this branch. TWO readers, one per service,
  # each with its own literal default; both rows must agree with the same compose value.
  "mcp-server~MANDREL_EMBEDDER~MANDREL_EMBEDDER~CODE~mcp-server/src/config/embeddingConfig.ts~envStr\\('MANDREL_EMBEDDER', *'([^']*)'\\)~"
  # Ollama endpoint for the gemma embedder. ONE reader: only the
  # mcp-server embeds; the Command backend has no row because it has no reader.
  "mcp-server~MANDREL_OLLAMA_ENDPOINT~MANDREL_OLLAMA_ENDPOINT~CODE~mcp-server/src/config/embeddingConfig.ts~envStr\\('MANDREL_OLLAMA_ENDPOINT', *'([^']*)'\\)~"
  "mcp-server~MANDREL_OAUTH_ENABLED~MANDREL_OAUTH_ENABLED~CODE~mcp-server/src/config/betterAuthConfig.ts~envBool\\('MANDREL_OAUTH_ENABLED', *(true|false)\\)~"
  "mcp-server~MANDREL_OAUTH_ISSUER~MANDREL_OAUTH_ISSUER~PASSTHROUGH~~~envStr folds '' into its fallback (betterAuthConfig.ts:23-25), so the code's http://localhost:8080 default still applies"
  "mcp-server~MANDREL_OAUTH_RESOURCE~MANDREL_OAUTH_RESOURCE~PASSTHROUGH~~~code default is DERIVED (\${issuer}/mcp); an empty passthrough is the only honest mirror of a derived default"
  "mcp-server~MANDREL_OAUTH_SECRET~MANDREL_OAUTH_SECRET~PASSTHROUGH~~~real credential: interpolated passthrough only, never a literal in a tracked file"
  "mcp-server~MANDREL_OAUTH_BASE_PATH~MANDREL_OAUTH_BASE_PATH~CODE~mcp-server/src/config/betterAuthConfig.ts~envStr\\('MANDREL_OAUTH_BASE_PATH', *'([^']*)'\\)~"
  "mcp-server~MANDREL_OAUTH_ALLOW_SIGNUP~MANDREL_OAUTH_ALLOW_SIGNUP~CODE~mcp-server/src/config/betterAuthConfig.ts~envBool\\('MANDREL_OAUTH_ALLOW_SIGNUP', *(true|false)\\)~"
  "mcp-server~MANDREL_OAUTH_CORS_ORIGINS~MANDREL_OAUTH_CORS_ORIGINS~CODE~mcp-server/src/config/betterAuthConfig.ts~envList\\('MANDREL_OAUTH_CORS_ORIGINS', *\\['([^']*)'\\]\\)~"
  "mcp-server~MANDREL_OAUTH_TRUSTED_ORIGINS~MANDREL_OAUTH_TRUSTED_ORIGINS~PASSTHROUGH~~~code default is DERIVED ([issuer, ...corsOrigins]); envList folds '' into the fallback so the derivation still runs"
  "mcp-server~BETTER_AUTH_SECRET~BETTER_AUTH_SECRET~PASSTHROUGH~~~real credential, and better-auth's native name honoured only as a fallback behind MANDREL_OAUTH_SECRET"
  "mcp-server~MANDREL_OAUTH_RATELIMIT_ENABLED~MANDREL_OAUTH_RATELIMIT_ENABLED~CODE~mcp-server/src/config/oauthClientConfig.ts~envBool\\('MANDREL_OAUTH_RATELIMIT_ENABLED', *(true|false)\\)~"
  "mcp-server~MANDREL_OAUTH_DCR_RATE_WINDOW_SEC~MANDREL_OAUTH_DCR_RATE_WINDOW_SEC~CODE~mcp-server/src/config/oauthClientConfig.ts~envInt\\('MANDREL_OAUTH_DCR_RATE_WINDOW_SEC', *([0-9]+)\\)~"
  "mcp-server~MANDREL_OAUTH_DCR_RATE_MAX~MANDREL_OAUTH_DCR_RATE_MAX~CODE~mcp-server/src/config/oauthClientConfig.ts~envInt\\('MANDREL_OAUTH_DCR_RATE_MAX', *([0-9]+)\\)~"
  "mcp-server~MANDREL_OAUTH_DCR_CLIENT_CAP~MANDREL_OAUTH_DCR_CLIENT_CAP~CODE~mcp-server/src/config/oauthClientConfig.ts~envInt\\('MANDREL_OAUTH_DCR_CLIENT_CAP', *([0-9]+)\\)~"
  "mcp-server~MANDREL_OAUTH_DCR_SWEEP_ENABLED~MANDREL_OAUTH_DCR_SWEEP_ENABLED~CODE~mcp-server/src/config/oauthClientConfig.ts~envBool\\('MANDREL_OAUTH_DCR_SWEEP_ENABLED', *(true|false)\\)~"
  "mcp-server~MANDREL_OAUTH_DCR_TTL_DAYS~MANDREL_OAUTH_DCR_TTL_DAYS~CODE~mcp-server/src/config/oauthClientConfig.ts~envInt\\('MANDREL_OAUTH_DCR_TTL_DAYS', *([0-9]+)\\)~"
  "mcp-server~MANDREL_OAUTH_DCR_SWEEP_INTERVAL_MINUTES~MANDREL_OAUTH_DCR_SWEEP_INTERVAL_MINUTES~CODE~mcp-server/src/config/oauthClientConfig.ts~envInt\\('MANDREL_OAUTH_DCR_SWEEP_INTERVAL_MINUTES', *([0-9]+)\\)~"
  # Derived code default (path.join(process.cwd(), 'aidis.pid')). The compose value
  # deliberately pins a tmpfs path so a restart always starts lock-free (outage
  # 2026-06-27, c316494d) — a derived default cannot be compared to a literal.
  "mcp-server~AIDIS_LOCK_FILE~AIDIS_LOCK_FILE~EXEMPT~~~code default is DERIVED (processLock.ts:6 path.join(process.cwd(),'aidis.pid')); compose deliberately pins tmpfs"

  # --- mandrel-command-backend ----------------------------------------------
  "mandrel-command-backend~DATABASE_NAME~POSTGRES_DB~CODE~mandrel-command/backend/src/config/environment.ts~process\\.env\\.DATABASE_NAME \\|\\| '([^']*)'~"
  "mandrel-command-backend~DATABASE_USER~POSTGRES_USER~CODE~mandrel-command/backend/src/config/environment.ts~process\\.env\\.DATABASE_USER \\|\\| '([^']*)'~"
  "mandrel-command-backend~DATABASE_SSL~DATABASE_SSL~EXEMPT~~~parsed as (… ?? '').toLowerCase()==='true' (connection.ts:27) — absent means off, but no literal default token exists to compare"
  "mandrel-command-backend~MCP_AUTH_TOKEN~MCP_AUTH_TOKEN~PASSTHROUGH~~~real credential; empty means 'send no Authorization header', which is exactly environment.ts:140's own default"
  "mandrel-command-backend~MANDREL_AGENT_TOKEN~MANDREL_AGENT_TOKEN~PASSTHROUGH~~~real credential (inbound); empty means the agent path is CLOSED and POST /api/git/push-stats falls back to user-JWT auth, which is exactly environment.ts's own default"
  # No literal code default: environment.ts:122-127 throws in production and generates
  # a random dev secret otherwise. The compose value is a placeholder that every live
  # tenant overrides in its env file.
  "mandrel-command-backend~JWT_SECRET~JWT_SECRET~EXEMPT~~~environment.ts:122-127 THROWS in production / randomises in dev — no literal default to mirror"
  "mandrel-command-backend~MANDREL_JWT_SECRET~JWT_SECRET~EXEMPT~~~same reader as JWT_SECRET (environment.ts:122); no literal default to mirror"
  "mandrel-command-backend~LOG_LEVEL~LOG_LEVEL~CODE~mandrel-command/backend/src/config/logger.ts~level: process\\.env\\.LOG_LEVEL \\|\\| '([^']*)'~"
  # RECONCILED 2026-07-30. This test found the two sides disagreeing on its very first
  # run — compose `info` vs code `warn` — a divergence nobody had chosen and nothing had
  # ever reported. It was pinned as a DIVERGES exception for exactly as long as it took
  # to get a decision, then compose was moved to `warn` (toward the code, i.e. toward
  # LESS query logging on customer instances) and the row became an ordinary CODE row.
  # That is the intended lifecycle of an exception here: visible, justified, temporary.
  "mandrel-command-backend~DB_LOG_LEVEL~DB_LOG_LEVEL~CODE~mandrel-command/backend/src/config/logger.ts~level: process\\.env\\.DB_LOG_LEVEL \\|\\| '([^']*)'~"
  "mandrel-command-backend~MANDREL_EMBEDDER~MANDREL_EMBEDDER~CODE~mandrel-command/backend/src/config/embeddingColumn.ts~process\\.env\\.MANDREL_EMBEDDER \\|\\| '([^']*)'~"

  # --- one-compose fold: declarations moved from the 7 gitignored
  # --- per-tenant overrides into the tracked base, so they enter this contract ----
  "mcp-server~MCP_AUTH_TOKEN~MCP_AUTH_TOKEN~PASSTHROUGH~~~real credential (static bridge bearer); empty means 'no static token configured' and a deploy preflight is expected to fail loud for real instances"
  # mcp-server~MANDREL_JWT_SECRET row REMOVED: the Option-1 shared
  # secret is retired — the command backend keeps the only copy; the mcp-server's
  # browser-JWT verify path is intentionally unavailable (bridgeAuthConfig
  # commandJwtSecret() → null). Re-adding the declaration re-opens F-01's posture.
  "mcp-server~MCP_ALLOWED_HOSTS~MCP_ALLOWED_HOSTS~PASSTHROUGH~~~every tenant env sets it explicitly (measured across all 7, 2026-08-03) and the hosted provisioner mints it; empty means the code's own host-check default applies"
  # DIVERGES, deliberately: the bundled install defaults to the 11-tool gateway
  # surface the README describes; the code default stays `legacy` so a bare `node` start and the
  # existing tenant overlays keep today's flat surface. The regex pins the code side.
  "mcp-server~MANDREL_TOOL_SURFACE~MANDREL_TOOL_SURFACE~DIVERGES~mcp-server/src/config/toolSurfaceConfig.ts~envEnum\\('MANDREL_TOOL_SURFACE', TOOL_SURFACES, '([^']*)'\\)~legacy"
  "mcp-server~MANDREL_TOOLLIST_MODE~MANDREL_TOOLLIST_MODE~CODE~mcp-server/src/config/toolSurfaceConfig.ts~envEnum\\('MANDREL_TOOLLIST_MODE', TOOLLIST_MODES, '([^']*)'\\)~"
  "mcp-server~MANDREL_ACTOR_COMPOSITE_ENABLED~MANDREL_ACTOR_COMPOSITE_ENABLED~CODE~mcp-server/src/config/actorIdentityConfig.ts~COMPOSITE_ENABLED_DEFAULT = (true|false)~"
  "mcp-server~MANDREL_ANCHOR_STRICT_SESSION_KEYING~MANDREL_ANCHOR_STRICT_SESSION_KEYING~CODE~mcp-server/src/config/reliableThreadingConfig.ts~ANCHOR_STRICT_SESSION_KEYING_DEFAULT = (true|false)~"
  "mcp-server~MANDREL_ACTOR_PROJECT_STATE_ENABLED~MANDREL_ACTOR_PROJECT_STATE_ENABLED~CODE~mcp-server/src/config/actorProjectStateConfig.ts~ACTOR_PROJECT_STATE_ENABLED_DEFAULT = (true|false)~"

  # --- BRANCH MODEL ---------------------------------------
  # BRANCH-1 declared limbs + BRANCH-2 terminality.
  # Every one of these six code defaults is a NAMED EXPORTED CONSTANT rather than a
  # literal buried in the config object, which is what lets these rows extract it
  # without a TypeScript parse. If someone inlines one of them back into the object
  # the regex stops matching and this file REDs (fail-closed), which is the intended
  # outcome — not a silent skip.
  "mcp-server~MANDREL_LIMBS_WRITE_TIME_ENABLED~MANDREL_LIMBS_WRITE_TIME_ENABLED~CODE~mcp-server/src/config/declaredLimbsConfig.ts~envBool\\('MANDREL_LIMBS_WRITE_TIME_ENABLED', (true|false)\\)~"
  "mcp-server~MANDREL_LIMBS_BACKFILL_BATCH~MANDREL_LIMBS_BACKFILL_BATCH~CODE~mcp-server/src/config/declaredLimbsConfig.ts~envInt\\('MANDREL_LIMBS_BACKFILL_BATCH', ([0-9]+)\\)~"
  "mcp-server~MANDREL_THREAD_TERMINALITY~MANDREL_THREAD_TERMINALITY~CODE~mcp-server/src/config/threadTerminalityConfig.ts~THREAD_TERMINALITY_DEFAULT: ThreadTerminalityMode = '([^']*)'~"
  "mcp-server~MANDREL_THREAD_TERMINALITY_TRANSIT_THETA~MANDREL_THREAD_TERMINALITY_TRANSIT_THETA~CODE~mcp-server/src/config/threadTerminalityConfig.ts~THREAD_TERMINALITY_THETA_DEFAULT = ([0-9.]+)~"
  "mcp-server~MANDREL_THREAD_TERMINALITY_UNASSIGNABLE_TERMINAL~MANDREL_THREAD_TERMINALITY_UNASSIGNABLE_TERMINAL~CODE~mcp-server/src/config/threadTerminalityConfig.ts~THREAD_TERMINALITY_UNASSIGNABLE_DEFAULT = (true|false)~"
  "mcp-server~MANDREL_THREAD_TERMINALITY_NOT_DERIVED_TERMINAL~MANDREL_THREAD_TERMINALITY_NOT_DERIVED_TERMINAL~CODE~mcp-server/src/config/threadTerminalityConfig.ts~THREAD_TERMINALITY_NOT_DERIVED_DEFAULT = (true|false)~"
  # BELIEF ADJUDICATION (Batch 8 lane L1, reconciled by an earlier task).
  #
  # This was a DIVERGES exception: the code default was `true` (unsafe — an absent key was the
  # loudest state, MEASURED 2026-08-29 across the fleet). an earlier Task moved the CODE toward
  # compose: with MANDREL_BELIEF_ENABLED unset the hook now turns on only when the configured
  # provider's credential is present, and the no-credential default is the named constant
  # BELIEF_ENABLED_NO_CREDENTIAL_DEFAULT = false. Compose no longer declares MANDREL_BELIEF_ENABLED
  # at all (a forced `false` defeated the key-derived default), so it has no row here;
  # scripts/test/supersession-compose-forwarding.test.sh pins that it is not fixed to false.
  "mcp-server~MANDREL_BELIEF_ADJUDICATOR_PROVIDER~MANDREL_BELIEF_ADJUDICATOR_PROVIDER~PASSTHROUGH~~~a provider only means anything on an instance that is ON, and there is exactly one place that posture is written down (that instance's env file); envStr folds '' into the code default so this line states no opinion"
  "mcp-server~ANTHROPIC_API_KEY~ANTHROPIC_API_KEY~PASSTHROUGH~~~real credential: interpolated passthrough only, never a literal in a tracked file. Source name is the documented .env name so docs/manual/supersession.md works as written"
  "mcp-server~GROQ_API_KEY~MANDREL_BELIEF_GROQ_API_KEY~PASSTHROUGH~~~real credential; same shell-precedence reasoning as ANTHROPIC_API_KEY above"
  "mcp-server~SUBQ_API_KEY~SUBQ_API_KEY~PASSTHROUGH~~~real credential; same sourcing as ANTHROPIC_API_KEY above"
  "mcp-server~MANDREL_BELIEF_DAILY_SPEND_CAP_USD~MANDREL_BELIEF_DAILY_SPEND_CAP_USD~PASSTHROUGH~~~empty folds into the code default of 2 (beliefCostConfig.ts envNonNeg); forwarded so the cap set in .env reaches the server"
  # DIVERGES, deliberately: the compose dev default keeps the HISTORICAL base-compose
  # literal (13000 = the dev frontend HOST port, 3000 = the container port) while the
  # code default is 3000,3001. Every real tenant sets CORS_ORIGIN in its env file
  # (written by the hosted provisioner), so this literal only
  # ever reaches a bare dev stack — where 13000 is the port the browser actually uses.
  # Aligning either side is a behaviour decision, not a drift fix; pinned from both ends.
  "mandrel-command-backend~CORS_ORIGIN~CORS_ORIGIN~DIVERGES~mandrel-command/backend/src/config/environment.ts~process\\.env\\.CORS_ORIGIN \\|\\| '([^']*)'~http://localhost:3000,http://localhost:3001"
  "mandrel-command-backend~FRONTEND_URL~FRONTEND_URL~EXEMPT~~~value is never read by backend code (grep process.env.FRONTEND_URL -> 0 hits, measured 2026-08-03); de-required from backend/.env.example 2026-08-26 so no longer a boot contract — it is minted per tenant by the hosted provisioner and read by nobody"
)
# ↑ ANTI-SHRINK FLOOR, co-located on the table it guards (same posture as the sibling
# test). It is also ANCHORED TO THE ARTIFACT below: the floor must be >= the number of
# defaulted declarations actually present, so setting it to 0 does not silently disable
# the anti-shrink check. Adding a declaration therefore requires bumping this line —
# intended and fail-loud, because the floor is the only backstop against a row AND its
# declaration vanishing together.
# Floor 50 -> 49: mcp-server~MANDREL_JWT_SECRET contract row removed
# with its compose declaration (Option-1 shared-secret retirement).
# Floor 49 -> 55: six BRANCH-MODEL declarations added with their rows
# (2 x MANDREL_LIMBS_*, 4 x MANDREL_THREAD_TERMINALITY*).
# Floor 55 -> 56: MANDREL_PROVENANCE_ALARM_ENABLED declaration added
# with its DIVERGES row (tenants explicitly OFF vs code's NODE_ENV==production default).
# Floor 56 -> 57 (gemma flip): MANDREL_OLLAMA_ENDPOINT declaration
# added with its CODE row (wire-only; default mirrors embeddingConfig.ts).
# Floor 57 -> 58 (SK5): MANDREL_BRIEFING_BRANCH_SCOPE_ENABLED declaration
# added with its CODE row (compose false == briefingConfig.ts false). Raised because the
# population GREW by one — never to quiet the guard, which caught the missing row correctly.
# Floor 58 -> 59 (P5.1, briefing render altitude): MANDREL_BRIEFING_ALTITUDE_ENABLED
# declaration added with its CODE row (compose true == briefingAltitudeConfig.ts true).
# Floor 64 -> 70 (attribution notice): six MANDREL_ATTRIBUTION_* declarations added with
# their rows (1 CODE + 5 PASSTHROUGH). Raised because the population GREW by six — the
# guard correctly reported the floor had fallen below the artifact it guards.
DEFAULT_CONTRACT_FLOOR=71

# =============================================================================
# THE CHECKER — written to a temp file so the mutation probes in section 4 can run
# the SAME code against mutated copies of the compose file and the code tree. One
# implementation, exercised by both the real run and every probe: a probe that ran a
# different checker would prove nothing.
# =============================================================================
cat >"$CHECKER" <<'PYEOF'
#!/usr/bin/env python3
"""Assert every ${VAR:-default} in a compose file agrees with its code default.

argv: <compose file> <repo root> <contract rows file>
Prints one line per assertion (PASS/FAIL) and exits 1 if any assertion failed or
if the population is empty (an empty population must never read as a pass).
"""
import re
import sys
import yaml

compose_path, repo_root, rows_path = sys.argv[1], sys.argv[2], sys.argv[3]

failures = []
checks = 0


def ok(msg):
    global checks
    checks += 1
    print(f"    ok   {msg}")


def bad(msg):
    global checks
    checks += 1
    failures.append(msg)
    print(f"    RED  {msg}")


# --- the population: every ${VAR:-default} in every service's environment block ---
with open(compose_path) as fh:
    doc = yaml.safe_load(fh) or {}

DEFAULTED = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*):-(.*)\}$", re.S)

declarations = {}  # (service, KEY) -> (VAR, default)
for service, body in (doc.get("services") or {}).items():
    env = (body or {}).get("environment") or {}
    if isinstance(env, list):  # list form: ["KEY=value", ...]
        env = dict((item.split("=", 1) + [""])[:2] for item in env)
    for key, value in env.items():
        m = DEFAULTED.match(str(value))
        if m:
            declarations[(service, key)] = (m.group(1), m.group(2))

# --- the contract rows ---
rows = {}
for raw in open(rows_path).read().splitlines():
    if not raw.strip():
        continue
    parts = raw.split("~")
    if len(parts) != 7:
        bad(f"malformed contract row (want 7 tilde-separated fields, got {len(parts)}): {raw!r}")
        continue
    service, key, var, kind, code_file, regex, extra = parts
    rows[(service, key)] = dict(var=var, kind=kind, file=code_file, regex=regex, extra=extra)

# --- 1. coverage, BOTH directions -------------------------------------------------
for ident, (var, default) in sorted(declarations.items()):
    if ident in rows:
        ok(f"coverage: {ident[0]}.{ident[1]} (${{{var}:-{default}}}) has a contract row")
    else:
        bad(f"coverage: {ident[0]}.{ident[1]} is a defaulted declaration with NO contract row "
            f"— every fleet-wide default must state whether it agrees with its code default")
for ident in sorted(rows):
    if ident not in declarations:
        bad(f"rot: contract row {ident[0]}.{ident[1]} has no matching ${{VAR:-default}} declaration "
            f"in the compose file — the row or the declaration was removed without the other")

# --- 2. the agreement itself ------------------------------------------------------
def extract(row, ident):
    """The literal code default, or None (and a RED) if the regex no longer matches."""
    path = f"{repo_root}/{row['file']}"
    try:
        text = open(path).read()
    except OSError as exc:
        bad(f"{ident}: cannot read code file {row['file']} ({exc.__class__.__name__}) "
            f"— the row points at a file that moved")
        return None
    found = re.findall(row["regex"], text)
    if not found:
        bad(f"{ident}: extraction regex matched NOTHING in {row['file']} — the code default moved "
            f"or was rewritten; this row can no longer prove anything (failing closed)")
        return None
    values = {f if isinstance(f, str) else f[0] for f in found}
    if len(values) > 1:
        bad(f"{ident}: extraction regex matched CONFLICTING defaults {sorted(values)} in "
            f"{row['file']} — ambiguous, refusing to guess")
        return None
    return values.pop()

for ident, (var, compose_default) in sorted(declarations.items()):
    row = rows.get(ident)
    if row is None:
        continue
    label = f"{ident[0]}.{ident[1]}"
    kind = row["kind"]

    if row["var"] != var:
        bad(f"{label}: contract row names interpolation var {row['var']!r} but the compose "
            f"declaration interpolates {var!r}")

    if kind == "CODE":
        code_default = extract(row, label)
        if code_default is None:
            continue
        if code_default == compose_default:
            ok(f"{label}: compose default {compose_default!r} == code default {code_default!r} "
               f"({row['file']})")
        else:
            bad(f"{label}: COMPOSE DEFAULT CONTRADICTS THE CODE — compose says "
                f"{compose_default!r}, {row['file']} says {code_default!r}. Either the "
                f"declaration is no longer wire-only (it silently changes fleet behaviour), "
                f"or a code default was hardened and never reached the fleet. Fix one side, "
                f"or reclassify this row to DIVERGES with a written justification.")

    elif kind == "DIVERGES":
        expected = row["extra"]
        if not expected:
            bad(f"{label}: DIVERGES row must state the expected code default")
            continue
        code_default = extract(row, label)
        if code_default is None:
            continue
        if code_default != expected:
            bad(f"{label}: DIVERGES row expects code default {expected!r} but {row['file']} "
                f"now says {code_default!r} — the justified exception is out of date, "
                f"re-justify it")
        elif code_default == compose_default:
            bad(f"{label}: DIVERGES row but the two sides now AGREE ({compose_default!r}) — "
                f"the exception is obsolete; reclassify this row to CODE and delete the "
                f"justification")
        else:
            ok(f"{label}: JUSTIFIED DIVERGENCE pinned from both ends — compose "
               f"{compose_default!r} vs code {code_default!r} ({row['file']})")

    elif kind == "PASSTHROUGH":
        if not row["extra"].strip():
            bad(f"{label}: PASSTHROUGH row must carry a written reason")
        elif compose_default == "":
            ok(f"{label}: empty passthrough — cannot contradict the code default "
               f"({row['extra']})")
        else:
            bad(f"{label}: classified PASSTHROUGH but the compose default is "
                f"{compose_default!r}, not empty — a real value here DOES pre-empt the code "
                f"default; reclassify to CODE or DIVERGES")

    elif kind == "EXEMPT":
        if not row["extra"].strip():
            bad(f"{label}: EXEMPT row must carry a written reason — an exemption without a "
                f"reason is a silent skip")
        else:
            ok(f"{label}: exempt ({row['extra']})")

    else:
        bad(f"{label}: unknown row KIND {kind!r} (want CODE|DIVERGES|PASSTHROUGH|EXEMPT)")

# --- 3. the population must not be empty ------------------------------------------
# An empty compose (or a walk that silently stopped matching) would otherwise sail
# through with zero assertions and read as a pass. CLASSES.md C3: probe the empty
# population.
if not declarations:
    bad("population is EMPTY: the walk found no ${VAR:-default} declarations at all — "
        "a parser that matches nothing is not a passing guard")

print(f"    -- {checks} assertion(s), {len(failures)} failed, "
      f"{len(declarations)} declaration(s) in population")
sys.exit(1 if failures else 0)
PYEOF

# The rows, one per line, in a file the checker reads (keeps the table in THIS file,
# co-located with its justifications, while the checker stays generic).
ROWS_FILE="$TMPD/rows.txt"
printf '%s\n' "${DEFAULT_CONTRACT[@]}" >"$ROWS_FILE"

run_checker() { # <compose file> <repo root> [rows file]
  python3 "$CHECKER" "$1" "$2" "${3:-$ROWS_FILE}" 2>&1
}

# =============================================================================
hdr "1. TABLE SELF-CHECKS — the contract cannot be vacuous"
# =============================================================================
row_count=${#DEFAULT_CONTRACT[@]}
if (( row_count >= DEFAULT_CONTRACT_FLOOR )); then
  pass "anti-shrink floor: $row_count row(s) >= floor of $DEFAULT_CONTRACT_FLOOR"
else
  fail "anti-shrink floor: the table shrank to $row_count row(s), below the declared floor of $DEFAULT_CONTRACT_FLOOR — a row was deleted without lowering the floor beside it"
fi

decl_count=$(python3 - "$COMPOSE_FILE" <<'PY'
import re, sys, yaml
doc = yaml.safe_load(open(sys.argv[1])) or {}
pat = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*):-(.*)\}$", re.S)
n = 0
for _svc, body in (doc.get("services") or {}).items():
    env = (body or {}).get("environment") or {}
    if isinstance(env, list):
        env = dict((i.split("=", 1) + [""])[:2] for i in env)
    n += sum(1 for v in env.values() if pat.match(str(v)))
print(n)
PY
)
if (( DEFAULT_CONTRACT_FLOOR >= decl_count )); then
  pass "floor is anchored to the artifact: floor $DEFAULT_CONTRACT_FLOOR >= $decl_count defaulted declaration(s) in the base compose"
else
  fail "floor ($DEFAULT_CONTRACT_FLOOR) is BELOW the $decl_count defaulted declaration(s) — the floor has been weakened relative to the artifact it guards"
fi

# Every row must be well-formed, and every CODE/DIVERGES regex must have exactly one
# capture group. A zero-group regex would make extraction silently return the whole
# match; a two-group one would make it ambiguous.
malformed=0
for row in "${DEFAULT_CONTRACT[@]}"; do
  IFS='~' read -r _svc _key _var kind cfile crx _extra <<<"$row"
  case "$kind" in
    CODE|DIVERGES)
      [[ -n "$cfile" && -n "$crx" ]] || { fail "row '$row' is $kind but has no code file/regex"; malformed=1; }
      [[ -f "$REPO_DIR_REAL/$cfile" ]] || { fail "row '$row' points at a missing file: $cfile"; malformed=1; }
      ;;
    PASSTHROUGH|EXEMPT)
      [[ -z "$cfile" && -z "$crx" ]] || { fail "row '$row' is $kind but carries a code file/regex"; malformed=1; }
      ;;
    *) fail "row '$row' has unknown KIND '$kind'"; malformed=1 ;;
  esac
done
(( malformed == 0 )) && pass "every contract row is well-formed and its code file exists"

if python3 - "$ROWS_FILE" <<'PY'
import re, sys
bad = 0
for line in open(sys.argv[1]):
    parts = line.rstrip("\n").split("~")
    if len(parts) != 7:
        continue
    _s, _k, _v, kind, _f, rx, _e = parts
    if kind in ("CODE", "DIVERGES"):
        if re.compile(rx).groups != 1:
            print(f"regex for {_s}.{_k} has {re.compile(rx).groups} capture group(s), want exactly 1")
            bad = 1
sys.exit(bad)
PY
then pass "every CODE/DIVERGES extraction regex has exactly one capture group"
else fail "an extraction regex does not have exactly one capture group"
fi

# =============================================================================
hdr "2. THE CONTRACT — every compose default vs the code that reads it"
# =============================================================================
CONTROL_OUT="$TMPD/control.out"
run_checker "$COMPOSE_FILE" "$REPO_DIR_REAL" >"$CONTROL_OUT"; control_rc=$?
sed 's/^/  /' "$CONTROL_OUT"
if (( control_rc == 0 )); then
  pass "UNMUTATED CONTROL IS GREEN: no compose default contradicts its code default"
else
  fail "the live compose file contradicts a code default (see the RED lines above)"
fi

# =============================================================================
hdr "3. THE JUSTIFIED EXCEPTIONS ARE LISTED, NOT SKIPPED"
# =============================================================================
# A DIVERGES row is only legitimate if it is visible. Assert each one is REPORTED by
# name in the control output, so an exception can never be a silent pass.
diverges_rows=0
for row in "${DEFAULT_CONTRACT[@]}"; do
  IFS='~' read -r svc key _var kind _f _r _e <<<"$row"
  [[ "$kind" == "DIVERGES" ]] || continue
  diverges_rows=$((diverges_rows+1))
  if grep -q "JUSTIFIED DIVERGENCE pinned from both ends" <<<"$(grep -F "$svc.$key" "$CONTROL_OUT")"; then
    pass "$svc.$key is an explicitly listed, pinned-from-both-ends exception (not a skip)"
  else
    fail "$svc.$key is declared DIVERGES but the checker did not report it as a pinned exception"
  fi
done
# ZERO is the healthy state and, as of 2026-07-30, the actual one — both original
# exceptions were resolved rather than kept. But a loop over an empty set asserts
# NOTHING, and the DIVERGES branch of the checker would then be dead code that nobody
# would notice rotting (CLASSES.md C3: probe the empty population). Section 4z below
# exercises that branch against a SYNTHETIC row so it stays proved at zero.
pass "DIVERGES rows currently listed: $diverges_rows (zero is healthy; the branch itself is proved by probe 4z)"

# =============================================================================
hdr "4. MUTATION PROBES — break it and watch it go RED"
# =============================================================================
# Each probe: (a) show the mutation LANDED, (b) the checker goes RED, and the
# unmutated control above was GREEN. A probe whose mutation silently no-ops proves
# nothing, so (a) is asserted separately every time.
probe_compose() { # <label> <sed expression> <expected substring in the RED output>
  local label="$1" sedexpr="$2" want="$3"
  local dir="$TMPD/probe-$$-$RANDOM"; mkdir -p "$dir"
  cp "$COMPOSE_FILE" "$dir/docker-compose.yml"
  sed -i "$sedexpr" "$dir/docker-compose.yml"
  if diff -q "$COMPOSE_FILE" "$dir/docker-compose.yml" >/dev/null; then
    fail "[$label] MUTATION DID NOT LAND — the sed was a no-op, so this probe proves nothing"
    return
  fi
  pass "[$label] mutation LANDED: $(diff "$COMPOSE_FILE" "$dir/docker-compose.yml" | grep -c '^[<>]') changed line(s)"
  local out; out=$(run_checker "$dir/docker-compose.yml" "$REPO_DIR_REAL"); local rc=$?
  if (( rc != 0 )) && grep -qF "$want" <<<"$out"; then
    pass "[$label] guard went RED for the right reason"
  elif (( rc != 0 )); then
    fail "[$label] guard went RED but not for the expected reason (wanted: $want)"
  else
    fail "[$label] GUARD STAYED GREEN through the mutation — it does not detect this"
  fi
}

# 4a. THE HEADLINE CASE: a compose default silently contradicting its code default.
probe_compose "compose default flipped (MANDREL_EMBEDDER minilm -> gemma)" \
  's|\${MANDREL_EMBEDDER:-minilm}|${MANDREL_EMBEDDER:-gemma}|' \
  "COMPOSE DEFAULT CONTRADICTS THE CODE"

# 4b. A boolean posture flag flipped in compose only — the "hardening never reached
#     the fleet" shape.
probe_compose "posture flag flipped (MCP_BRIDGE_AUTH_ENABLED true -> false)" \
  's|\${MCP_BRIDGE_AUTH_ENABLED:-true}|${MCP_BRIDGE_AUTH_ENABLED:-false}|' \
  "COMPOSE DEFAULT CONTRADICTS THE CODE"

# 4c. An integer knob — proves the guard is not boolean/enum-shaped only.
probe_compose "integer knob changed (MANDREL_OAUTH_DCR_RATE_MAX 5 -> 9)" \
  's|\${MANDREL_OAUTH_DCR_RATE_MAX:-5}|${MANDREL_OAUTH_DCR_RATE_MAX:-9}|' \
  "COMPOSE DEFAULT CONTRADICTS THE CODE"

# 4d. THE REGRESSION THAT MATTERS ON THE SCOPE GUARD: someone puts a literal back on the
#     key, re-overwriting the code's fail-closed default at the container boundary. This
#     is the exact edit the soak-ending change removed.
probe_compose "hardcoded default reintroduced (MANDREL_PROJECT_SCOPE_GUARD passthrough -> shadow)" \
  's|\${MANDREL_PROJECT_SCOPE_GUARD:-}|${MANDREL_PROJECT_SCOPE_GUARD:-shadow}|' \
  "classified PASSTHROUGH but the compose default is"

# 4d2. AND THE "HELPFUL" VERSION IS ALSO RED. Writing `:-enforce` looks like an
#      improvement and is still the defect: it re-pins a per-deployment value in a
#      tracked file, so the next change to the code default silently stops reaching the
#      fleet. The guard must not reward the value being currently-correct.
probe_compose "hardcoded default reintroduced with the RIGHT value (passthrough -> enforce)" \
  's|\${MANDREL_PROJECT_SCOPE_GUARD:-}|${MANDREL_PROJECT_SCOPE_GUARD:-enforce}|' \
  "classified PASSTHROUGH but the compose default is"

# 4e. A new defaulted declaration with no contract row.
probe_compose "new undeclared flag (a defaulted declaration with no row)" \
  's|^\( *\)MANDREL_EMBEDDER: "\${MANDREL_EMBEDDER:-minilm}"|&\n\1MANDREL_PROBE_NEW_FLAG: "${MANDREL_PROBE_NEW_FLAG:-nope}"|' \
  "NO contract row"

# 4f. A PASSTHROUGH that stops being a passthrough — an empty default replaced by a
#     real value, which DOES pre-empt the code default.
probe_compose "passthrough given a real value (COMMAND_BASE_URL '' -> a hostname)" \
  's|\${COMMAND_BASE_URL:-}|${COMMAND_BASE_URL:-https://probe.invalid}|' \
  "classified PASSTHROUGH but the compose default is"

# 4g. THE EMPTY POPULATION — the value that slips through every guard. A compose file
#     with no defaulted declarations must NOT read as a pass.
EMPTY_DIR="$TMPD/empty"; mkdir -p "$EMPTY_DIR"
printf 'services:\n  mcp-server:\n    environment:\n      NODE_ENV: production\n' >"$EMPTY_DIR/docker-compose.yml"
empty_out=$(run_checker "$EMPTY_DIR/docker-compose.yml" "$REPO_DIR_REAL"); empty_rc=$?
if (( empty_rc != 0 )) && grep -qF "population is EMPTY" <<<"$empty_out"; then
  pass "[empty population] a compose with zero defaulted declarations is RED, not a silent pass"
else
  fail "[empty population] a compose with zero defaulted declarations read as a PASS"
fi

# 4h. MUTATE THE **CODE** SIDE, not the compose side. This is the direction the whole
#     test exists for: someone hardens a code default and the fleet never gets it.
CODE_DIR="$TMPD/code-mutant"
mkdir -p "$CODE_DIR/mcp-server/src/config"
cp "$REPO_DIR_REAL/mcp-server/src/config/embeddingConfig.ts" "$CODE_DIR/mcp-server/src/config/"
sed -i "s|envStr('MANDREL_EMBEDDER', *'minilm')|envStr('MANDREL_EMBEDDER', 'gemma')|g" \
  "$CODE_DIR/mcp-server/src/config/embeddingConfig.ts"
if diff -q "$REPO_DIR_REAL/mcp-server/src/config/embeddingConfig.ts" \
           "$CODE_DIR/mcp-server/src/config/embeddingConfig.ts" >/dev/null; then
  fail "[code-side mutation] the sed did not land — probe proves nothing"
else
  pass "[code-side mutation] mutation LANDED in embeddingConfig.ts (minilm -> gemma)"
  # Only the mutated file needs to exist under the fake root; every other row's file
  # will be unreadable there, which is itself a RED — so narrow the rows to the one
  # under test, keeping the probe's signal unambiguous.
  ONE_ROW="$TMPD/one-row.txt"
  printf '%s\n' "mcp-server~MANDREL_EMBEDDER~MANDREL_EMBEDDER~CODE~mcp-server/src/config/embeddingConfig.ts~envStr\\('MANDREL_EMBEDDER', *'([^']*)'\\)~" >"$ONE_ROW"
  ONE_COMPOSE="$TMPD/one-compose.yml"
  printf 'services:\n  mcp-server:\n    environment:\n      MANDREL_EMBEDDER: "${MANDREL_EMBEDDER:-minilm}"\n' >"$ONE_COMPOSE"
  # control for THIS probe: same single row against the UNMUTATED tree -> GREEN
  if run_checker "$ONE_COMPOSE" "$REPO_DIR_REAL" "$ONE_ROW" >/dev/null; then
    pass "[code-side mutation] single-row control against the real tree is GREEN"
  else
    fail "[code-side mutation] single-row control is RED against the real tree — probe is unsound"
  fi
  out=$(run_checker "$ONE_COMPOSE" "$CODE_DIR" "$ONE_ROW"); rc=$?
  if (( rc != 0 )) && grep -qF "COMPOSE DEFAULT CONTRADICTS THE CODE" <<<"$out"; then
    pass "[code-side mutation] guard went RED when the CODE default moved and compose did not"
  else
    fail "[code-side mutation] guard stayed GREEN when the code default moved away from compose"
  fi
fi

# 4z. THE DIVERGES BRANCH, PROVED AT ZERO REAL DIVERGES ROWS.
# There are none left in the live table (both were resolved), so the branch that handles
# justified exceptions is otherwise unexercised — and an unexercised branch in a guard is
# a guard that will be silently broken by the next refactor. Drive it with a SYNTHETIC
# compose + rows pair, against the REAL callerIdentityConfig.ts, through all three of its
# outcomes.
SYN_DIR="$TMPD/diverges-synthetic"; mkdir -p "$SYN_DIR"
SYN_COMPOSE="$SYN_DIR/docker-compose.yml"
printf 'services:\n  mcp-server:\n    environment:\n      MANDREL_PROJECT_SCOPE_GUARD: "${MANDREL_PROJECT_SCOPE_GUARD:-shadow}"\n' >"$SYN_COMPOSE"
SYN_RX="PROJECT_SCOPE_GUARD_DEFAULT: ProjectScopeGuardMode = '([^']*)'"
syn_row() { printf '%s\n' "mcp-server~MANDREL_PROJECT_SCOPE_GUARD~MANDREL_PROJECT_SCOPE_GUARD~DIVERGES~mcp-server/src/config/callerIdentityConfig.ts~${SYN_RX}~$1"; }

syn_row enforce >"$SYN_DIR/ok.txt"
if out=$(run_checker "$SYN_COMPOSE" "$REPO_DIR_REAL" "$SYN_DIR/ok.txt") && grep -qF "JUSTIFIED DIVERGENCE pinned from both ends" <<<"$out"; then
  pass "[4z control] a correct DIVERGES row (compose 'shadow' vs real code 'enforce') is GREEN and reported as an exception"
else
  fail "[4z control] a correct DIVERGES row did not go green — the branch is broken, so the RED cases below prove nothing"
fi

# (i) the stated code default no longer matches reality -> the exception is out of date.
syn_row off >"$SYN_DIR/stale.txt"
out=$(run_checker "$SYN_COMPOSE" "$REPO_DIR_REAL" "$SYN_DIR/stale.txt"); rc=$?
if (( rc != 0 )) && grep -qF "the justified exception is out of date" <<<"$out"; then
  pass "[4z] DIVERGES row whose stated code default is stale -> RED"
else
  fail "[4z] a stale DIVERGES justification stayed GREEN"
fi

# (ii) the two sides silently converged -> the exception is obsolete and must be removed.
printf 'services:\n  mcp-server:\n    environment:\n      MANDREL_PROJECT_SCOPE_GUARD: "${MANDREL_PROJECT_SCOPE_GUARD:-enforce}"\n' >"$SYN_DIR/converged.yml"
out=$(run_checker "$SYN_DIR/converged.yml" "$REPO_DIR_REAL" "$SYN_DIR/ok.txt"); rc=$?
if (( rc != 0 )) && grep -qF "the two sides now AGREE" <<<"$out"; then
  pass "[4z] DIVERGES row whose two sides converged -> RED (obsolete exception must be reclassified)"
else
  fail "[4z] an obsolete DIVERGES exception stayed GREEN"
fi

# (iii) an exception with no stated expectation is just a skip wearing a costume.
printf '%s\n' "mcp-server~MANDREL_PROJECT_SCOPE_GUARD~MANDREL_PROJECT_SCOPE_GUARD~DIVERGES~mcp-server/src/config/callerIdentityConfig.ts~${SYN_RX}~" >"$SYN_DIR/blank.txt"
out=$(run_checker "$SYN_COMPOSE" "$REPO_DIR_REAL" "$SYN_DIR/blank.txt"); rc=$?
if (( rc != 0 )) && grep -qF "must state the expected code default" <<<"$out"; then
  pass "[4z] DIVERGES row with no stated expectation -> RED (an exception must justify itself)"
else
  fail "[4z] a DIVERGES row with no justification stayed GREEN"
fi

# 4i. THE ROW-DELETION BYPASS: delete a row while its declaration stands.
SHORT_ROWS="$TMPD/short-rows.txt"
grep -v '^mcp-server~MANDREL_EMBEDDER~' "$ROWS_FILE" >"$SHORT_ROWS"
if [[ "$(wc -l <"$SHORT_ROWS")" -lt "$(wc -l <"$ROWS_FILE")" ]]; then
  pass "[row deletion] mutation LANDED: $(( $(wc -l <"$ROWS_FILE") - $(wc -l <"$SHORT_ROWS") )) row removed"
  out=$(run_checker "$COMPOSE_FILE" "$REPO_DIR_REAL" "$SHORT_ROWS"); rc=$?
  if (( rc != 0 )) && grep -qF "NO contract row" <<<"$out"; then
    pass "[row deletion] guard went RED — a declaration cannot lose its row silently"
  else
    fail "[row deletion] guard stayed GREEN with a row deleted"
  fi
else
  fail "[row deletion] mutation did not land"
fi

# =============================================================================
printf '\n%s%d passed, %d failed%s\n' "$BLD" "$PASS" "$FAIL" "$RST"
if (( FAIL == 0 )); then
  printf '%sPASS: every ${VAR:-default} in the tracked base compose agrees with the code default that reads it, or is an explicitly listed and justified exception.%s\n' "$GRN" "$RST"
  printf '%sNOT PROVEN BY THIS RUN: per-tenant overlays, env_file contents, and systemd prod — none of them are files in this repo (see the blind-spot list in the header).%s\n' "$YLW" "$RST"
  exit 0
fi
printf '%sFAIL: a compose default contradicts the code that reads it (or the guard itself was weakened).%s\n' "$RED" "$RST"
exit 1
