# Using the loop

This guide is for the person who writes punches and reads what the loop reports. To install and
configure the loop first, see [runtime setup](runtime-setup.md).

## The mental model

A **punch** is a task on your Mandrel board with a contract: what to build, and a list of
`doneWhen` clauses that say how anyone can tell it is built. The loop moves each punch through four
roles, one tick at a time:

```
picker ─► worker ─► critic ─► merger
```

| Role | Does | Leaves the punch at |
| --- | --- | --- |
| Picker | Chooses a `ready` punch that is valid, unclaimed, not tagged `risk:gate` or `loop:exhausted`, and whose `dependsOn` are all closed. Higher priority first. | `claimed` |
| Worker | Runs `claude` in a fresh git worktree on a `loop/<id8>-<slug>` branch and builds the change. Counts as done only if the branch exists and differs from `main`; the loop checks git, not what the model says. | `verifying` |
| Critic | A second, different model checks out the branch at the recorded sha and decides each `doneWhen` clause by running things itself. | `evidence` (PASS), otherwise see [verdicts](#reading-a-critic-verdict) |
| Merger | Lands a PASSed punch: opens a pull request (`pr` mode) or gates and merges to `main` (`direct` mode). | `merged` |

The worker never grades its own work, and the critic never edits the code under test.

## Writing a good punch

A punch is as good as its `doneWhen`. The critic can only check what a clause says, so each clause
must be something a stranger could prove true or false by running a command.

```json
{
  "title": "Add the greet function and its test",
  "description": "Add src/greet.ts exporting greet(name) and test/greet.test.ts covering it.",
  "size": "xs",
  "repo": "my-repo",
  "dependsOnIndex": [],
  "doneWhen": [
    { "text": "greet(\"Ada\") returns \"Hello, Ada!\"", "owner": "lane", "proof": "test/greet.test.ts" },
    { "text": "the wording of the usage line is friendly", "owner": "human" }
  ],
  "proofKind": "test"
}
```

- **`description`**: say what to build and name the files the punch creates. The worker reads it.
- **`owner`**: `lane` means the loop proves it; `human` means a person decides. A `human` clause is
  recorded as `human clause` by the critic and never blocks a PASS, so keep anything the loop must
  actually verify as `lane`.
- **`proof`** (required on every `lane` clause): a repo-relative path to the test or file that shows
  the clause holds, or the exact text `walkthrough evidence (not committed to the repo)` when the
  proof is something the critic observes and does not commit. Absolute paths, `~`, `..` and URLs are
  rejected.
- **`proofKind`**: `test` (a test fails without the change and passes with it), `browser` or `look`.
- **Keep code and its proof together.** If a clause's proof is created by a later punch, `lint`
  reports `proof-created-later`.
- **Say what is true, not how it was run.** Clauses that mention `docker`, `systemctl` and the like,
  absolute system paths, or phrases such as `in the background` fail `lint`.
- **Size it.** Use `size:` `xs` to `xl`; smaller punches fail less often. Tag it `repo:<tag>` with a
  tag that is a key of `repos` in your config.
- **Hand-written punches** need a `repo:<tag>` tag, a `size:` tag and valid `doneWhen`; the
  simplest route is the planner, below.

### Mutation clauses

A test that cannot fail proves nothing. To make the critic show the test can fail, add a clause
containing the exact words `Critic applies and shows RED`, then name each mutation:

```json
{
  "text": "Critic applies and shows RED: delete the row for an existing key from the docs table; add a new accepted key to the loader without documenting it. Unmutated control GREEN.",
  "owner": "lane",
  "proof": "walkthrough evidence (not committed to the repo)"
}
```

For each mutation the critic applies it, runs the proof and expects it to FAIL (the red run), reverts
it, then runs the proof again and expects it to PASS (the green run). The loop re-checks a PASS
mechanically: a mutation with no red run, or whose red and green runs both pass, turns the PASS into
a FAIL.

## Stages, and what moves a punch

| Stage | Meaning | What moves it on |
| --- | --- | --- |
| `draft` | Written, not yet released. | The loop promotes a draft with `dependsOn` once all of them have closed (note `loop: dependencies closed`). A draft without dependencies waits for you: `mandrel-loop ready <task-id>`. A draft the worker has already worked (it has a `lane`) is never auto-promoted. |
| `ready` | Waiting to be picked. | The picker, on a tick with a free lane (`lanes`). |
| `claimed` | A worker has it. The loop renews the lease every 5 minutes. | The worker finishing (to `verifying`), or failing (back to `ready`). |
| `verifying` | The critic is, or will be, checking it. | The critic's verdict. |
| `evidence` | PASSed; the verdict and its evidence are on the punch. | The merger. |
| `merged` | Landed. | (`deployed` is a stage you set when it ships.) |

`mandrel-loop status` prints `<stage>: <count>` for every stage. `mandrel-loop once` runs one tick;
`mandrel-loop run` ticks every `tickSeconds`. Each transition is printed as a JSON line on stdout.

Every plan, worker and critic Claude run also logs one cost line to stderr:
`claude run: role=<role> punch=<id8> cost=$<total_cost_usd>`. The `tick:` summary line adds the tick's
run count and summed cost.

## Reading a critic verdict

The critic writes `verdict.json` (the source of record) into `<workdir>/critic/<id8>/evidence/`, and
the loop copies the result onto the punch (`task({action:'details'})` shows `walkthrough`, `verdict`, `sha`).
The note on the punch says what the critic found.

| Verdict | Means | Punch goes to |
| --- | --- | --- |
| `PASS` | Every `lane` clause verified, mutations showed RED then GREEN. | `evidence`, then the merger |
| `FAIL` | At least one `lane` clause is false of the checkout. The note says which and why. | `ready`, failures attached; the next worker attempt sees them |
| `COULD-NOT-MEASURE` | The critic could not run what a clause needs (missing tool, no network, a mode that blocks commands). Not a failure of the change. | stays in `verifying`; retried next tick |
| `CONTRACT-DEFECT` | A clause cannot be verified as written: ambiguous, unfalsifiable or contradicting the description. | `draft`, for you to fix the punch |

Each clause in `verdict.json` has `verified` and an `evidence` string saying what the critic ran and
saw; mutation clauses carry a `red` and a `green` run per mutation. The raw output the critic saved
sits next to `verdict.json`.

## What to do when it does not pass

- **FAIL.** Read the note and the failing clause. The loop retries automatically: the worker gets the
  failures on the next attempt. After `critic.maxAttempts` FAILs (default 2) the punch is tagged
  `loop:exhausted` and the picker ignores it. Fix the cause (usually the punch is too large or the
  clause too vague), remove the tag, and move the punch back to `ready`.
- **COULD-NOT-MEASURE.** Treat it as an environment problem. Run `mandrel-loop doctor`. Check that the
  critic can run commands (`critic.permissionMode`), that tools the proof needs are installed for the
  service user, and that the network is reachable. Nothing is lost; the next tick retries.
- **CONTRACT-DEFECT.** Rewrite the clause so it names a command and an expected result, run
  `mandrel-loop lint`, then `mandrel-loop ready <task-id>`.
- **Worker exhausted.** After `worker.maxAttempts` attempts without a commit the punch gets
  `loop:exhausted` and the note `giving up (loop:exhausted)`.

## Retiring a punch and changing its repo

The picker only works a `ready` punch whose `repo:<tag>` is a key of `repos` in your config. One that
names anything else is skipped on every tick, logged once per tick as `tick: skipping <id>: ...`, and stays
`ready`; it does not block the punches behind it.

- **Change its repo.** Edit the task's tags: replace `repo:work` with `repo:<key>` (a key of `repos`),
  keep the `size:` tag. With the Mandrel `task` tool that is `task({action:'update', taskId, tags: ["repo:app", "size:s"]})`.
  The next tick picks it up. Do this for a punch that was applied before the check existed, or after
  you rename a key in `repos`.
- **Retire a punch.** Add the `loop:exhausted` tag (the picker ignores it) and set the task status to
  `cancelled` with `task({action:'update'})`. A `cancelled` status counts as closed, so punches that `dependsOn` it
  become eligible: retire or rewrite those too if they need the retired work.
- **Bring a retired punch back.** Remove `loop:exhausted`, fix the repo tag if needed, set the status
  back to `todo`, and make sure the stage is `ready`.

## Pull request flow (`pr` mode)

In `pr` mode a PASSed punch is pushed and a pull request is opened with `gh`. The tick prints
`tick: <id8> pr-opened: <url>` and the URL is recorded in the punch's `pr` field. The punch stays in
`evidence` until the pull request is merged on GitHub; the loop then moves it to `merged`. Review
and merge it like any other pull request: your CI and reviewers are the gate. If the branch moves
after the verdict, the merger sends the punch back to `verifying`
(`merger: branch <b> is at <sha>, verdict was measured at <sha>`) so the critic re-checks the new
tip. In `direct` mode there is no pull request; the repo's `gate` command decides, and a red gate
returns the punch to `ready` with `merger: gate RED` and the tail of the output.

## From a spec to punches

Write a spec, then:

```bash
mandrel-loop plan spec.md           # asks claude to split it into punches.json
mandrel-loop lint punches.json      # check the authoring rules; edit the file by hand
mandrel-loop plan --apply punches.json
```

Everything lands as `draft`. See [from a spec to punches](spec-to-punches.md) for the file format
and the lint rules, then release drafts with `mandrel-loop ready <task-id>`.

## Troubleshooting

These are real messages, with the cause and the fix.

| You see | Cause and fix |
| --- | --- |
| `invalid config:` followed by `worker: Unrecognized key(s) in object: 'user'` | A key the loader does not accept. See the key table in [runtime setup](runtime-setup.md#every-key). |
| `merge.mode: "rebase" is not supported (expected pr or direct)` | Only `pr` and `direct` exist. |
| `models.worker and models.critic are the same model; set critic.allowSameModel to permit it` | Pick two different models, or opt in. |
| `cannot read config <file>: ...` / `config is not valid JSON: ...` | Wrong `--config` path, or a JSON syntax error. |
| `missing Mandrel token: MANDREL_TOKEN` | Export the variable in the loop's environment (the service's env file). |
| `check mandrel-ping failed: <url>/mcp could not complete an MCP call (...)` | Mandrel is down, `mandrel.url` is wrong, or the network between the loop and the server blocks it. |
| `check mandrel-endpoint failed: task.list: HTTP 405: no MCP endpoint at <url>/mcp` | `mandrel.url` is not the server's base URL. Give the base URL (`https://you.mandrel.example`); the loop adds `/mcp`. |
| `check mandrel-auth failed: <url>/mcp refused the token in MANDREL_TOKEN (...)` | The token is wrong or revoked. Hosted: create one in Settings → API tokens. Self-hosted: use the server's `MCP_AUTH_TOKEN`. |
| `check mandrel-project failed: <url>/mcp does not know the gateway tool the loop calls (...)` | The Mandrel server predates the gateway tools. Upgrade it. |
| `check mandrel-project failed: project "x" is not usable (...)` | Create the project or correct `mandrel.project`; the line names the projects your token can see. |
| `check git-ls-remote failed: ...` | The clone cannot reach its remote; run `gh auth setup-git` or fix the SSH key. |
| `check git-identity failed: ... git user.email is not set` | `git config --global user.email "you@example.com"` as the service user. |
| `refusing to run as root (uid 0)` | Run as an ordinary user. |
| `tick: <id> not started: <reason>` and the note `loop: worker not started: <reason>` | The worker could not start (missing `claude`, bad credential, lost claim). The punch is back in `ready`. Three in a row make `run` exit 3. |
| `loop: released a stale claim` | The loop died mid-attempt; the lease lapsed and the punch was released. Normal after a restart. |
| `task <id> has no valid punch; run lint and fix it first` | `ready` refuses a punch whose contract is invalid. |
| `task <id> is at stage <stage>; only draft punches can be marked ready` | `ready` only moves a `draft`. |
| `no verdict.json and no MANDREL-LOOP-VERDICT: line` | The critic ended without writing a verdict; usually its permission mode blocked writing. See `critic.permissionMode`. |
| `refusing to apply: <n> lint violation(s)` | Fix the violations `lint` lists. |
| `planner output contained no JSON array` | `plan` got no JSON from `claude`; rerun, or write `punches.json` by hand. |

Hardening the worker and critic is covered in [hardened mode](hardened-mode.md).
