# Setting up the loop runtime

This guide takes you from nothing to a loop running as a service. For using it once it runs, see
the [user guide](user-guide.md). The README in `loop/` is the short version; this is the long one.

## What you need

| Need | Why | How to check |
| --- | --- | --- |
| Node 22 or newer ([install from nodejs.org](https://nodejs.org/en/download)) | The loop is a Node program (`engines.node` is `>=22`). A distro package (Ubuntu 24.04's apt gives 18.x) is often too old. | `node --version` |
| `git` | Worktrees, branches, merges. | `git --version` |
| The `claude` CLI | The worker and the critic are `claude -p` runs. | `claude --version` |
| Claude authentication | The worker and critic run unattended, so they need a credential in place. | Sign in once with Claude Code (`~/.claude/.credentials.json`), or export `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. |
| A Mandrel server, hosted or self-hosted | The board: punches are tasks in a Mandrel project. The loop speaks MCP to the server's `/mcp` endpoint, the same one your MCP clients use. | `mandrel-loop doctor` (its `mandrel-ping`, `mandrel-auth` and `mandrel-project` checks) |
| A Mandrel token | Every request carries it as `Authorization: Bearer`. Hosted Mandrel: create one in **Settings → API tokens**. Self-hosted: the server's `MCP_AUTH_TOKEN` (in its `.env`). | `mandrel-loop doctor` (its `mandrel-auth` check) |
| `gh` and a GitHub repo | `pr` merge mode only: the loop opens pull requests with `gh`. | `gh auth status` |

The loop's board is Mandrel. It does not read GitHub Issues: there is no config key to pick another
board, and the only board implementation besides Mandrel is an in-memory one used by the tests. A
GitHub repository is where your code lives and, in `pr` mode, where the pull requests go. If you
only have GitHub, you still need a Mandrel server to hold the punches.

## Install `mandrel-loop`

From a clone of this repository:

```bash
cd mandrel/loop
npm ci
npm run build
node dist/cli.js --version        # works in place, nothing else needed
```

To get `mandrel-loop` on your PATH without root:

```bash
npm pack
npm install -g --prefix "$HOME/.local" ./mandrel-loop-*.tgz
export PATH="$HOME/.local/bin:$PATH"     # put this in your shell profile
mandrel-loop --version
```

Do the same as the user that will run the service, so that the service's `HOME` is the one that has
your Claude sign-in and git identity.

## Prepare the host

1. **Create the Mandrel project** the config names. From any MCP client connected to your Mandrel,
   call `project({action:'create', name:'my-project'})`; `project({action:'list'})` shows what
   exists. `doctor` checks that it exists and, when it does not, names the projects your token sees.
2. **Clone each repository** the loop will build, at a path you will put in `repos.<tag>.path`.
   Use a clone with a working remote; the loop pushes branches from it.
3. **Set a git identity** for the service user: `git config --global user.name "Your Name"` and
   `git config --global user.email "you@example.com"`.
4. **Let git push.** `GH_TOKEN` authenticates `gh` only, not `git push`. Run `gh auth setup-git`, or
   give the clone an SSH remote.
5. **Pick two different models**, one for the worker and one for the critic. The critic is meant to
   be an independent check, so the loader refuses the same id for both unless you opt in.

## The config file

The loop reads `mandrel-loop.config.json` from the current directory, or the file named by
`--config <file>`. Relative paths inside it (`repos.<tag>.path`, `workdir`) resolve against the
config file's directory. Unknown keys are rejected at any depth, and every error names the key.

The config never holds a secret. Where a key needs one, you give it the **name** of an environment
variable and the loop reads the value from its environment.

A complete example:

```json
{
  "mandrel": { "url": "http://localhost:8080", "project": "my-project" },
  "repos": {
    "my-repo": { "path": "./my-repo", "gate": "bash scripts/oss-gate.sh" }
  },
  "models": { "worker": "worker-model-id", "critic": "critic-model-id" },
  "merge": { "mode": "pr" }
}
```

### Every key

This table lists every key the loader (`loop/src/settings.ts`) accepts. The gate fails if a key is
missing from it or a row names a key the loader does not accept
(`loop/test/config-keys-documented.test.ts`). Defaults come from `loop/src/config.ts`.

| Key | Default | Meaning |
| --- | --- | --- |
| `mandrel.url` | required | Base URL of your Mandrel server, for example `https://you.mandrel.example` (hosted) or `http://localhost:8080` (self-hosted). The loop speaks MCP over streamable HTTP to `<url>/mcp`; a URL that already ends in `/mcp` is used as is. Must be a valid URL. |
| `mandrel.project` | required | Name of the Mandrel project whose punches the loop works. It must already exist. |
| `mandrel.tokenEnv` | `MANDREL_TOKEN` | Name of the environment variable holding the Mandrel token. |
| `mandrel.actor` | `loop` | Actor id the loop acts as on the board. It shows up as the claimant on every punch the loop touches. |
| `repos.<tag>` | `{}` | One entry per repository. A punch tagged `repo:<tag>` is built in that repository; a ready punch whose tag matches no entry is skipped by the picker (logged once per tick as `tick: skipping <id>: ...`) and stays `ready`; it never blocks other punches. `lint --config` and `plan --apply` reject such a punch; see [Retiring a punch and changing its repo](user-guide.md#retiring-a-punch-and-changing-its-repo). |
| `repos.<tag>.path` | required | Path to an existing clone of the repository. |
| `repos.<tag>.gate` | required | Command, run through `bash -c` in the repository, whose exit 0 means the tree is mergeable. Used in `direct` mode. Use `bash scripts/oss-gate.sh` style: exit 0 green, non-zero otherwise. |
| `repos.<tag>.main` | `main` | The integration branch worktrees start from and merges land on. |
| `repos.<tag>.remote` | `origin` | The remote the loop pushes to. |
| `repos.<tag>.gateTimeoutMinutes` | `30` | Time limit for the gate command, in minutes. Must be positive. |
| `models.worker` | required | Model id the worker runs as, passed to `claude --model`. |
| `models.critic` | required | Model id the critic runs as. Must differ from `models.worker` unless `critic.allowSameModel` is `true`. |
| `lanes` | `1` | Workers dispatched per tick. A positive integer; each lane is one concurrent `claude` process. |
| `tickSeconds` | `300` | Seconds between ticks in `run`. A positive integer. |
| `merge.mode` | `pr` | `pr` or `direct`; see [Choosing the merger mode](#choosing-the-merger-mode). |
| `worker.timeoutMinutes` | `45` | Wall-clock limit for one worker attempt, in minutes. On expiry the worker gets SIGTERM, then SIGKILL 5 seconds later. |
| `worker.maxAttempts` | `2` | Worker attempts before the punch is tagged `loop:exhausted` and left alone. |
| `worker.permissionMode` | `bypassPermissions` | Passed to `claude --permission-mode`. One of `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`. The worker runs unattended; read [hardened mode](hardened-mode.md). |
| `worker.allowRoot` | `false` | Allow running as uid 0. Only for throwaway containers. |
| `critic.maxAttempts` | `2` | Critic runs per punch before the loop stops retrying. |
| `critic.permissionMode` | `bypassPermissions` | Passed to the critic's `claude --permission-mode`; same values as the worker's. The critic must run commands to measure, so a mode that blocks them makes every verdict `COULD-NOT-MEASURE`. |
| `critic.allowSameModel` | `false` | Permit the worker and the critic to be the same model. |
| `workdir` | `~/.mandrel-loop` | Where worktrees (`worktrees/`) and critic checkouts and evidence (`critic/`) live. Relative paths resolve against the config file. |
| `notify.webhookUrlEnv` | unset | Name of an environment variable holding a webhook URL that receives each stage transition as JSON. |

### Credentials, by variable name

| Variable | Needed for |
| --- | --- |
| `MANDREL_TOKEN` (or the name in `mandrel.tokenEnv`) | Talking to Mandrel. Hosted: a token from Settings → API tokens. Self-hosted: the server's `MCP_AUTH_TOKEN`. |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | The worker and the critic, unless you signed in with Claude Code. |
| `GH_TOKEN` | `pr` mode: `gh pr create` and `gh pr view`. A prior `gh auth login` also works. |

Other environment variables the loop reads: `MANDREL_LOOP_CLAUDE_BIN` replaces the `claude` program
(used for sandbox wrappers, see hardened mode) and `MANDREL_LOOP_GH_BIN` replaces `gh`. Child
processes (worker, critic, gate) get only `PATH`, `HOME`, `LANG` and the worker credentials.

## Choosing the board

There is one real board, Mandrel, and it is chosen by `mandrel.url` and `mandrel.project`. Stages
(`draft`, `ready`, `claimed`, `verifying`, `evidence`, `merged`, `deployed`) are a field on each
Mandrel task. The loop has no mode that maps GitHub labels to stages. To use GitHub for review, use
`pr` mode; the issue tracker stays outside the loop.

## Choosing the merger mode

| | `pr` (default) | `direct` |
| --- | --- | --- |
| What lands the change | The loop pushes the branch, opens a pull request with `gh`, and waits for someone to merge it. | The loop runs the repo's `gate` on the merge candidate and, if it exits 0, merges to `main` and pushes. |
| Who is the gate | Your CI and reviewers. | The `gate` command in the config. |
| Needs | `GH_TOKEN` or `gh auth login` | A gate you trust and push rights to `main`. |
| Choose it when | Others review, or branch protection is on. | One owner, and a gate strong enough to be the only reviewer. |

`gate` is required for every repo in either mode (the loader insists), but only `direct` runs it.
A gate exit of 0 is green and the merge is pushed; 1 is red (the punch goes back to `ready` with the
gate's output tail as a note, starting `merger: gate RED`); any other exit, or a timeout, is reported
as `could-not-measure` and the punch stays in `evidence` for the next tick.

## Check the setup with `doctor`

```bash
mandrel-loop doctor --config mandrel-loop.config.json
```

It exits 0 with `doctor: all checks passed`, or exits 2 with one line per problem. Each live
check is named, and its line ends with `fix: ...`:

| Check | Passes when | If it fails |
| --- | --- | --- |
| config | The file parses and every key is valid. | The message starts `invalid config:` and lists each bad key by path. |
| token | The variable named by `mandrel.tokenEnv` is set. | `missing Mandrel token: MANDREL_TOKEN`: export it where the loop runs. |
| worker credential | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` or `~/.claude/.credentials.json` exists. | Sign in with Claude Code or export one of them. |
| gh credential | (`pr` mode) `GH_TOKEN` is set or `gh auth login` was done. | `missing gh credential (merge.mode is pr)`. |
| root | You are not uid 0. | `refusing to run as root (uid 0)`; run as a normal user, or set `worker.allowRoot` in a throwaway container. |
| `mandrel-ping` | Mandrel answers an MCP initialize at `<mandrel.url>/mcp`. | Start Mandrel, correct `mandrel.url`, or check the network between the loop and the server. |
| `mandrel-endpoint` | That URL is an MCP endpoint (initialize is not answered HTTP 400, 404 or 405, which is what a wrong path, a proxy or another app answers). | Set `mandrel.url` to the server's base URL; the loop adds `/mcp` itself. |
| `mandrel-auth` | The server accepts the token (not HTTP 401 or 403). | Hosted: create a token in Settings → API tokens. Self-hosted: use the server's `MCP_AUTH_TOKEN`. Export it under the name in `mandrel.tokenEnv`. |
| `mandrel-project` | `mandrel.project` exists and the server runs the `task` gateway tool (it does on either tool surface). | Use a name from the line's `this token sees:` list, or create it with `project({action:'create'})`. If the line says the server does not know the gateway tool, upgrade Mandrel. |
| `repo-path` | `repos.<tag>.path` exists. | Clone the repository there or correct the path. |
| `repo-git` | The path is a git repository. | `git clone` into it. |
| `git-ls-remote` | `git ls-remote` works against `repos.<tag>.remote`. | Check the remote name, network, and push credentials (`gh auth setup-git`, an SSH key). |
| `git-identity` | `user.name` and `user.email` are set. | `git config --global user.name "<value>"` and the same for `user.email`. |
| `task-claims` | The Mandrel server has task claims enabled (the loop claims every task it works). | Set the claims variable to `true` in the Mandrel server's environment (`.env` for the compose install) and restart it. |

The Mandrel checks come from one project-scoped `task` call, so they stop at the first that fails and
a single line names the cause: `mandrel-ping`, `mandrel-endpoint`, `mandrel-auth`, then
`mandrel-project`. `task-claims` runs only when they pass.

Do not start `run` until `doctor` is clean.

## Run it as a long-lived user service

```bash
mandrel-loop service --print linux     # a systemd user unit
mandrel-loop service --print macos     # a launchd agent
```

`service --print` writes nothing; save the text where its first line says. The unit runs
`mandrel-loop run --config <your config>` with `Restart=on-failure` and a 30-second delay. On Linux:

```bash
mkdir -p ~/.config/systemd/user ~/.config/mandrel-loop
mandrel-loop service --print linux > ~/.config/systemd/user/mandrel-loop.service   # path from the first line of the output
install -m 0600 /dev/null ~/.config/mandrel-loop/env
$EDITOR ~/.config/mandrel-loop/env          # MANDREL_TOKEN=..., ANTHROPIC_API_KEY=..., GH_TOKEN=...
systemctl --user daemon-reload
systemctl --user enable --now mandrel-loop
loginctl enable-linger "$USER"              # keep it running after you log out
journalctl --user -u mandrel-loop -f        # follow the log
```

The environment file holds `NAME=value` lines. Keep it mode 0600. `run` exits 3 after three
consecutive workers that could not start (usually a broken `claude` install or credential), and
`Restart=on-failure` then retries after the delay.

## Hardened mode

The worker defaults to `bypassPermissions` and runs as whoever runs the loop. Before you leave it
running unattended, read [hardened mode](hardened-mode.md): a dedicated user, a narrower
`worker.permissionMode`, and an optional sandbox wrapper through `MANDREL_LOOP_CLAUDE_BIN`.

## Upgrading

1. Stop the service: `systemctl --user stop mandrel-loop`.
2. Update the clone (`git pull`), then in `loop/` run `npm ci && npm run build`. If you installed a
   packed copy, repeat `npm pack` and `npm install -g --prefix "$HOME/.local" ./mandrel-loop-*.tgz`.
3. Check `mandrel-loop --version`, then run `mandrel-loop doctor`. A key removed or renamed in the
   new version fails here with `invalid config:` and the key's path, since unknown keys are rejected.
   Compare your config to the key table above.
4. Start the service: `systemctl --user start mandrel-loop`.

Punches in flight survive a restart: a lapsed claim returns to `ready` with the note
`loop: released a stale claim` on the next tick.

Next: [using the loop](user-guide.md).
