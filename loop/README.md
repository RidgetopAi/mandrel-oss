# mandrel-loop

The reference Punch List loop for Mandrel. It is a client of Mandrel's public tool API, spoken over
MCP at `<mandrel.url>/mcp` (the same endpoint your MCP clients use, hosted or self-hosted): it reads
`ready` punches from your board, hands each one to a coding agent (the **worker**) on its own git
worktree, has a second, independent model (the **critic**) verify every `doneWhen` clause, and then
merges the result, either through a pull request or directly.

```
draft ─► ready ─► claimed ─► verifying ─► evidence ─► merged
              worker builds ┘   critic verifies ┘    merger lands it
```

You need: Node 22 or newer (install it from <https://nodejs.org/en/download>; a distro package such as Ubuntu 24.04's apt `nodejs` is often too old, check with `node --version`), `git`, the [Claude Code](https://claude.com/claude-code) CLI as `claude`,
a running Mandrel server, and (for `pr` mode) the GitHub CLI `gh`.

**Guides:** [runtime setup](../docs/loop/runtime-setup.md) (prerequisites, every config key, `doctor`,
running as a service, upgrading) and the [user guide](../docs/loop/user-guide.md) (writing punches,
stages, critic verdicts, troubleshooting). The sections below are the short version.

## Install from the clone

```bash
git clone <this repository> mandrel && cd mandrel/loop
npm ci
npm run build
node dist/cli.js --version     # run it in place, no install needed
```

To put `mandrel-loop` on your PATH without root, install it under your home directory:

```bash
npm pack                                   # creates mandrel-loop-<version>.tgz
npm install -g --prefix "$HOME/.local" ./mandrel-loop-*.tgz
export PATH="$HOME/.local/bin:$PATH"       # add this line to your shell profile
mandrel-loop --version
```

(`npm link` also works, but it writes to the global prefix and needs root on many systems.)

## Before the first run

1. **Get a Mandrel token.** On hosted Mandrel, create one in **Settings → API tokens**. On a
   self-hosted server, use the server's `MCP_AUTH_TOKEN` (in its `.env`). Export it as
   `MANDREL_TOKEN` (or the name you set in `mandrel.tokenEnv`).
2. **Create the Mandrel project.** `mandrel.project` must name a project that already exists. From
   any MCP client connected to your Mandrel (Claude Code, Claude.ai), call
   `project({action:'create', name:'my-project'})`; `project({action:'list'})` shows what exists.
   `doctor` checks it, and when the project is missing it names the projects your token can see.
   A self-hosted server also answers plain HTTP. Replace the URL, token and name with your own:

   ```bash
   curl -X POST "<mandrel.url>/mcp/tools/project_create" \
     -H "Authorization: Bearer <your token>" \
     -H "X-Connection-ID: my-setup" \
     -H "X-Actor-ID: <your-name>" \
     -H "Content-Type: application/json" \
     -d '{"arguments":{"name":"my-project","description":"Work for mandrel-loop"}}'
   ```

   Once the loop runs, the URL of each pull request it opens is printed by the tick as
   `tick: <id8> pr-opened: <url>` and recorded in the punch's `pr` field (visible with
   `task({action:'details'})`).
3. **Set a git identity** for the user that runs the loop. The worker commits and the merger merges,
   and both fail without one:

   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

4. **Let git push over HTTPS.** `GH_TOKEN` is read by the `gh` CLI only; it does **not** authenticate
   `git push`. Either run `gh auth setup-git` (after `gh auth login` or with `GH_TOKEN` set) so git
   uses `gh` as its credential helper, or give the repo an SSH remote. `doctor` checks that the
   remote answers `git ls-remote`.
5. **Choose two different models.** The critic must not be the worker's model. For example:

   ```json
   "models": { "worker": "claude-sonnet-4-5", "critic": "claude-opus-4-1" }
   ```

   Use whichever two model ids your Claude Code installation accepts for `--model`.

## Configure

The loop reads `mandrel-loop.config.json` from the current directory (or `--config <file>`).
Unknown keys are rejected, at any depth (for example `worker.user`). Relative paths resolve against the config file's directory.

```bash
# doctest
cat > mandrel-loop.config.json <<'JSON'
{
  "mandrel": { "url": "http://localhost:8080", "project": "my-project" },
  "repos": {
    "my-repo": { "path": "./my-repo", "gate": "bash scripts/oss-gate.sh" }
  },
  "models": { "worker": "worker-model-id", "critic": "critic-model-id" },
  "merge": { "mode": "pr" }
}
JSON
```

| Key | Default | Meaning |
| --- | --- | --- |
| `mandrel.url` | required | Base URL of your Mandrel server, for example `https://you.mandrel.example` or `http://localhost:8080`. The loop speaks MCP to `<url>/mcp`; a URL that already ends in `/mcp` is used as is. |
| `mandrel.project` | required | Name of the Mandrel project whose punches the loop works. |
| `mandrel.tokenEnv` | `MANDREL_TOKEN` | **Name** of the environment variable holding the Mandrel token. |
| `mandrel.actor` | `loop` | Actor id the loop acts as on the board. |
| `repos.<tag>` | `{}` | One entry per repository. A punch tagged `repo:<tag>` is built in that repository. |
| `repos.<tag>.path` | required | Path to an existing clone of the repository. |
| `repos.<tag>.gate` | required | Command (run through `bash -c` in the repo) whose exit 0 means the tree is mergeable. Used in `direct` mode. |
| `repos.<tag>.main` | `main` | The integration branch. |
| `repos.<tag>.remote` | `origin` | The remote the loop pushes to. |
| `repos.<tag>.gateTimeoutMinutes` | `30` | Time limit for the gate command. |
| `models.worker` | required | Model the worker runs as. |
| `models.critic` | required | Model the critic runs as. It must differ from the worker's unless `critic.allowSameModel` is true. |
| `lanes` | `1` | Workers dispatched per tick. |
| `tickSeconds` | `300` | Seconds between ticks in `run`. |
| `merge.mode` | `pr` | `pr` or `direct` (see below). |
| `worker.timeoutMinutes` | `45` | Wall-clock limit for one worker attempt. |
| `worker.maxAttempts` | `2` | Attempts before a punch is tagged `loop:exhausted` and left alone. |
| `worker.permissionMode` | `bypassPermissions` | Passed to `claude --permission-mode`. The worker runs unattended, so read [hardened mode](../docs/loop/hardened-mode.md). |
| `worker.allowRoot` | `false` | Allow running as uid 0. Only for throwaway containers. |
| `critic.permissionMode` | same as `worker.permissionMode` (`bypassPermissions`) | Passed to the critic's `claude --permission-mode`. The critic must run node/npm to measure; without a mode every verdict is `COULD-NOT-MEASURE`. |
| `critic.maxAttempts` | `2` | Critic runs per punch before it stops retrying. |
| `critic.allowSameModel` | `false` | Permit worker and critic to be the same model. |
| `workdir` | `~/.mandrel-loop` | Where worktrees and critic evidence live. |
| `notify.webhookUrlEnv` | unset | **Name** of an environment variable holding a webhook URL that receives each stage transition as JSON. |

## Authentication, by environment variable name

The config file never contains a secret; it names the variables. The loop reads values from its
environment and never prints them. `doctor` reports missing credentials by name only.

| Variable | Needed for |
| --- | --- |
| `MANDREL_TOKEN` | Talking to Mandrel: a token from Settings → API tokens (hosted) or the server's `MCP_AUTH_TOKEN` (self-hosted). Rename the variable with `mandrel.tokenEnv`. |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | The worker and the critic. Alternatively sign in with Claude Code (`~/.claude/.credentials.json`). |
| `GH_TOKEN` | `pr` mode only: `gh pr create` and `gh pr view`. A prior `gh auth login` also satisfies it. |

Child processes (worker, critic, gate) receive an allow-listed environment: `PATH`, `HOME`, `LANG`
and the worker credentials. Nothing else is inherited.

## Commands

### `doctor`: check before you run

```bash
# doctest
export MANDREL_TOKEN=example-token ANTHROPIC_API_KEY=example-key GH_TOKEN=example-gh
git init -q -b main my-repo.remote
git -C my-repo.remote -c user.name=Example -c user.email=example@example.com commit -q --allow-empty -m init
git clone -q my-repo.remote my-repo
git -C my-repo config user.name Example
git -C my-repo config user.email example@example.com
mandrel-loop doctor
```

Exit 0 and `doctor: all checks passed` when the config parses, the Mandrel token, a worker
credential (and in `pr` mode a gh credential) are present, you are not root, and the live checks
pass. Exit 2 with one line per problem otherwise. The live checks are each reported by name with a
fix hint: `mandrel-ping` (Mandrel answers an MCP initialize at `<mandrel.url>/mcp`),
`mandrel-endpoint` (that URL is an MCP endpoint, not a 400/404/405), `mandrel-auth` (the server accepts
the token), `mandrel-project` (the configured project exists, through one `task` gateway call), `repo-path` and `repo-git` (each repo path exists and is a git repository),
`git-ls-remote` (the repo's remote accepts `git ls-remote` with the current credentials) and
`git-identity` (git has `user.name` and `user.email` for commits) and `task-claims` (the Mandrel
server has task claims enabled, which the loop needs to claim every task).

### `once`: one tick

```bash
# doctest
export MANDREL_TOKEN=example-token ANTHROPIC_API_KEY=example-key GH_TOKEN=example-gh
mandrel-loop once
```

One sweep: renew or release leases, promote drafts whose `dependsOn` have closed, dispatch up to
`lanes` workers on `ready` punches, run the critic on `verifying` ones, merge `evidence` ones. Every
stage transition is printed to stdout as one JSON line; progress goes to stderr, including one cost line per Claude run
(`claude run: role=<role> punch=<id8> cost=$<total_cost_usd>`); the `tick:` summary adds the run count
and summed cost.

### `ready`: release a draft by hand

`mandrel-loop ready <task-id> [--config <file>]` moves one `draft` punch to `ready`. The loop only
promotes drafts that have `dependsOn`; a draft without dependencies waits for you to run `ready`. It
refuses a punch that is not a draft or has no valid punch contract (run `lint` first).

### `run`: tick forever

`mandrel-loop run` is `once` every `tickSeconds`, until SIGINT or SIGTERM. It exits 3 after three
consecutive workers that could not start (usually a broken `claude` install or credential).

### `status`: count punches per stage

```bash
# doctest
export MANDREL_TOKEN=example-token
mandrel-loop status
```

Prints `<stage>: <count>` for `draft`, `ready`, `claimed`, `verifying`, `evidence`, `merged` and
`deployed`.

### `lint`, `plan`: from a spec to punches

`plan <spec.md>` asks `claude` to turn a spec into `punches.json`; `lint` checks that file against
the authoring rules; `plan --apply` files the punches as drafts. See
[spec-to-punches](../docs/loop/spec-to-punches.md).

```bash
# doctest
cat > punches.json <<'JSON'
[
  {
    "title": "Add the parser module",
    "description": "Parse the config file into typed records.",
    "size": "s",
    "repo": "my-repo",
    "dependsOnIndex": [],
    "doneWhen": [
      { "text": "parse() returns typed records for a valid config", "owner": "lane", "proof": "test/parser.test.ts" }
    ],
    "proofKind": "test"
  }
]
JSON
mandrel-loop lint punches.json
```

### `service --print`: run it as a user service

```bash
# doctest
mandrel-loop service --print linux
mandrel-loop service --print macos
```

Prints a systemd user unit (`linux`) or a launchd agent (`macos`) that runs
`mandrel-loop run --config <this config>`. Nothing is written; save the text where its first line
says. The Linux unit reads optional extra variables from `~/.config/mandrel-loop/env`; put the
credentials listed above there with mode 0600.

## Leases, stale claims and not-started workers

A worker holds a claim on its punch. The loop renews the lease every 5 minutes while the worker
runs; the lease length itself is set by the Mandrel server. If the loop crashes, the lease lapses,
and the next tick (at most `tickSeconds` later, 5 minutes by default) moves the punch from `claimed`
back to `ready` with the note `loop: released a stale claim`.

When a worker could not start at all (a missing `claude`, a bad credential, a lost claim), the punch
returns to `ready` with the note `loop: worker not started: <reason>` on the punch, and the same
line is printed to stderr as `tick: <id> not started: <reason>`. Three such starts in a row make
`run` exit 3.

## `pr` mode and `direct` mode

| | `pr` (default) | `direct` |
| --- | --- | --- |
| What lands the change | The loop pushes the branch, opens a pull request with `gh`, and waits for it to be merged. | The loop runs the repo's `gate` on the merge candidate and, if it exits 0, merges to `main` and pushes. |
| Who is the gate | Your CI and reviewers on the pull request. | The `gate` command in the config. |
| Needs | `GH_TOKEN` (or `gh auth login`) | A `gate` you trust and push rights to `main`. |
| Choose it when | Others review, or branch protection is on. | A single-owner repo with a gate strong enough to be the only reviewer. |

A critic verdict other than `PASS` never merges: `FAIL` returns the punch to `ready` with the
failures attached, `COULD-NOT-MEASURE` keeps it in `verifying`, and `CONTRACT-DEFECT` sends it back to
`draft` for a human to fix the punch.

## Checking this document

Every fenced block above that starts with `# doctest` is executed by
`scripts/test/loop-readme-doctest.test.sh` against an in-memory board and stand-in `claude` and `gh`
programs, so the commands shown here keep working. Run it from the repository root.
