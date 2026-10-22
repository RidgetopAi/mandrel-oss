# Hardened mode: running the worker more safely

The loop runs a coding agent unattended. By default nothing asks before that agent edits a file or
runs a command. This page says what the default allows, which settings narrow it, and what the loop
does **not** do for you.

"Hardened mode" is not a single switch. There is no `hardened` key. It is the steps below, using
settings and hooks that exist today.

## What the default does

| | Default |
| --- | --- |
| Worker command | `claude -p --permission-mode bypassPermissions --output-format json --model <models.worker>`, with the brief on stdin |
| Worker directory | A fresh git worktree under `<workdir>/worktrees/` on a `loop/<id>-<slug>` branch |
| Critic command | `claude -p --output-format json --permission-mode <critic.permissionMode> --model <models.critic>`, in a detached checkout under `<workdir>/critic/<id>/tree` |
| Critic mode | Same as the worker's: `bypassPermissions` |
| Root | `doctor`, `once` and `run` refuse to start as uid 0 (exit 2) unless `worker.allowRoot` is `true` |
| Environment | Worker and critic get only `PATH`, `HOME`, `LANG`, `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (the critic also gets `MANDREL_LOOP_EVIDENCE_DIR`). The Mandrel token and `GH_TOKEN` are not passed to them. |
| Cost | Every plan, worker and critic run uses `--output-format json`; the loop reads the `result` text and logs one line per run (`claude run: role=<role> punch=<id8> cost=$<total_cost_usd>`). The `tick:` summary line adds the tick's run count and summed cost. |
| Time limit | `worker.timeoutMinutes` (45). On timeout the worker gets SIGTERM, then SIGKILL 5 seconds later. The critic's limit is a fixed 30 minutes. |

`bypassPermissions` means the agent can do anything the operating-system user running the loop can
do. A git worktree is a directory, not a sandbox: the agent can read and write outside it, use the
network, and read files under `HOME`, including any git or `gh` credentials stored there.

The loop checks the worker's result from git, not from what the model says. A worker counts as done
only when its branch exists and differs from `main`. A critic verdict other than `PASS` never merges.

## Step 1: run as a dedicated, unprivileged user

Create an ordinary user (no `sudo`) that owns only the repository clones in `repos` and the
`workdir`. Sign in to Claude Code and set the git identity as that user. Run the loop as that user,
for example with the unit printed by `mandrel-loop service --print linux`, installed in that user's
home.

Leave `worker.allowRoot` at `false`. Set it to `true` only inside a container you throw away after
the run. With it set, `doctor`, `once` and `run` still start as root, but print a warning.

## Step 2: choose a narrower permission mode

`worker.permissionMode` and `critic.permissionMode` accept exactly these values, which the loop
passes unchanged to `claude --permission-mode`:

`acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`

Any other value is rejected when the config is loaded. What each mode allows is defined by Claude
Code, not by the loop; read the permission documentation for your Claude Code version.

The worker runs non-interactively, so nobody is there to approve a request. To finish a punch the
worker must be able to edit files, run the tests the punch names, and run `git add` and
`git commit`, all without being asked. With any mode other than `bypassPermissions`, you allow those
actions through Claude Code's own permission rules, for example in a `.claude/settings.json`
committed to the repository (each worktree is a checkout of the repository, so the file is present
there). The loop has no allow list or deny list of its own.

The critic must also run commands: it builds and tests the branch, then writes `verdict.json` into
the directory named by `MANDREL_LOOP_EVIDENCE_DIR` (outside its checkout), or prints a
`MANDREL-LOOP-VERDICT:` line. If the mode blocks that, every verdict is `COULD-NOT-MEASURE` and
punches stay in `verifying`.

Try a new mode on one punch with `mandrel-loop once` before you start `run`. A worker that exits
without committing fails its attempt; after `worker.maxAttempts` failures the punch is tagged
`loop:exhausted` and left alone.

## Step 3: run the agent inside a sandbox you provide

The loop does not sandbox anything. It does let you replace the program it runs: if
`MANDREL_LOOP_CLAUDE_BIN` is set in the loop's environment, the loop runs that program instead of
`claude` for the worker, the critic and `plan`. Point it at a wrapper that starts `claude` inside a
container, a virtual machine, or another sandbox you trust.

```sh
#!/bin/sh
# Called with the same arguments and stdin the loop would give `claude`.
# Replace `your-sandbox` with the command that starts your sandbox.
exec your-sandbox -- claude "$@"
```

A wrapper must:

- pass every argument through and forward stdin, stdout, stderr and the exit status;
- run in the directory it was started in (the worktree or the critic's checkout);
- see the repository clone at the same path. A worktree's commits are written into the clone's
  `.git` directory, so a sandbox that shows only the worktree loses the commit;
- for the critic, make `MANDREL_LOOP_EVIDENCE_DIR` writable at the same path, because the loop reads
  `verdict.json` from there after the critic exits.

For the worker and the critic, the wrapper starts with the restricted environment listed above.
For `plan` it gets the loop's full environment (see below).

## Step 4: keep credentials out of reach

- Give the loop its tokens as environment variables. They reach the loop, not the worker or critic.
- Logins saved on disk under the loop user's `HOME` (for example after `gh auth login`) can be read
  by the agent. Use a dedicated user so that `HOME` holds nothing else of value.
- In `direct` mode the repository's `gate` command runs the worker's code on the merge candidate,
  outside any `MANDREL_LOOP_CLAUDE_BIN` wrapper. It gets the same allow-listed environment as the
  worker (`PATH`, `HOME`, `LANG` and the worker credentials), so the Mandrel token and `GH_TOKEN`
  do not reach it. `gh` gets that environment plus `GH_TOKEN`. Logins on disk under `HOME` are still
  readable. If the gate must be fully contained, use `pr` mode (the default), so your CI runs the
  code instead, or make the `gate` command itself start a sandbox.

## Step 5: keep a person in the path

- `pr` mode (the default) means a reviewer or CI merges, not the loop.
- A punch tagged `risk:gate` is never picked by the loop.
- `lanes` defaults to `1`: one worker at a time.

## What is not supported

- No built-in sandbox, container or virtual machine. Use `MANDREL_LOOP_CLAUDE_BIN` with your own.
- No setting to run the worker as a different operating-system user. The only user setting is
  `worker.allowRoot`.
- No network restriction.
- No per-tool allow or deny list in `mandrel-loop.config.json`; use Claude Code's settings.
- The worker's environment allow-list is fixed; it cannot be configured.
- `plan` runs `claude -p --output-format json` with no `--permission-mode` and no `--model`, with the loop's full
  environment, and does not check for root.
