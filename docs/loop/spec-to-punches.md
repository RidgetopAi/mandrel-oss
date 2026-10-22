# From a spec to punches

Three commands turn a written spec into punches on your board:

```
spec.md ──plan──► punches.json ──lint──► (fix by hand) ──plan --apply──► draft punches
```

| Command | What it does | Talks to |
| --- | --- | --- |
| `mandrel-loop plan <spec.md> [-o punches.json]` | Asks `claude` to split the spec into punches and writes them to a file (default `punches.json`). | `claude` |
| `mandrel-loop lint <punches.json>` | Checks the file against the authoring rules. | nothing |
| `mandrel-loop plan --apply <punches.json> [--config <file>]` | Lints the file again, then creates every punch on the board as a `draft`. | Mandrel |

Nothing reaches the board until you run `plan --apply`, so you can read and edit `punches.json` first.

## `plan`

`plan` sends the planner card (`loop/cards/planner.md`) followed by your spec to `claude -p` on
stdin, takes the first JSON array in the reply, and writes it to the output file. It then lints what
it wrote and prints `wrote <file>`, with the violation count if there are any: exit 0 when the file
is clean, exit 1 with one line per violation when it is not. The file is written either way, so you
can fix it. `lint` and `plan` also print a `warning [missing-mutation-clause]` line (exit status unchanged) for a `proofKind: test` punch with no `Critic applies and shows RED: <mutation>; <mutation>. Unmutated control GREEN.` clause. A reply with no JSON array is an error (exit 1, nothing
written).

`plan` reads `mandrel-loop.config.json` (or `--config <file>`) for one thing: the keys of `repos`. It tells the planner they are the only values `repo` may take (the only key when there is one), and lints the result against them. It runs `claude` with no `--model` flag, so the
model is your Claude Code default. Set `MANDREL_LOOP_CLAUDE_BIN` to run a different program.
Options: `-o <file>` and `--config <file>`.

## The punches file

`punches.json` is a JSON array. Each element is one punch:

| Field | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Short, imperative title. |
| `description` | yes | What to build and why. Name the files the punch creates here. |
| `size` | yes | `xs`, `s`, `m`, `l` or `xl`. |
| `repo` | yes | Must match a repo name (a key of `repos`) in your config, with or without the `repo:` prefix; `lint --config <file>` and `plan --apply` reject a punch naming any other repo, naming the punch and the valid keys. A punch that is already on the board with an unknown repo is skipped by the picker and stays `ready` (see [retiring a punch](user-guide.md#retiring-a-punch-and-changing-its-repo)). |
| `dependsOnIndex` | yes | Positions (0-based) of **earlier** punches in this file that must finish first. May be empty. |
| `doneWhen` | yes | At least one clause: `{ "text", "owner", "proof" }`. `owner` is `lane` (the loop proves it) or `human`. |
| `proofKind` | yes | `test`, `browser` or `look`. |
| `touches` | no | Repo-relative paths the punch creates or edits. |

A clause `proof` is a repo-relative path to the test or file that shows the clause holds, or the
exact text `walkthrough evidence (not committed to the repo)`.

## `lint`: the authoring rules

`lint` prints `lint: clean` and exits 0, or prints one line per violation, then
`lint: <n> violation(s)`, and exits 1. Each line names the rule:

| Rule | Fails when |
| --- | --- |
| `shape` | A field above is missing, empty or not one of its allowed values, or the file is not a non-empty array. |
| `missing-proof` | An `owner: "lane"` clause has no `proof`. |
| `non-relative-proof` | A `proof` is empty, absolute, starts with `~`, contains `..`, or is a URL. |
| `banned-word` | Clause text names a container or service-manager tool: `docker`, `docker-compose`, `podman`, `kubectl`, `helm`, `systemctl`, `systemd`, `journalctl`, `launchctl`, `supervisord`, `supervisorctl`, `pm2`. |
| `rooted-path` | Clause text contains an absolute path under a common system directory (`/home`, `/usr`, `/etc`, `/tmp`, …), a `~/...` path, or a Windows drive path such as `C:\...`. |
| `process-phrase` | Clause text says how something was run instead of what is true: `in the foreground`, `in the background`, `before any`, `started from`, `started with`, `launched from`, `was run from`, `as a daemon`. |
| `dependency` | `dependsOnIndex` is not an array, or names the punch itself or a later one. |
| `proof-created-later` | A clause's `proof` is created (named in `description` or `touches`) only by a later punch. Keep code and its test in one punch. |

`lint <file>` checks the authoring rules above. Pass `--config <file>` to also check every `repo` against the keys of `repos` (rule `unknown-repo`); `plan` and `plan --apply` always do.

The word lists live in `loop/src/lint.config.ts`.

## `plan --apply`

`plan --apply` reads the config (`mandrel-loop.config.json`, or `--config <file>`) and lints the file
first. If there is any violation it prints `refusing to apply: <n> lint violation(s)` with the list,
exits 1, and creates nothing. Otherwise it creates the punches in file order and prints one
`<id> <title>` line per punch, then `applied: <n> draft(s)`.

Each punch is created:

- at stage `draft`;
- tagged `repo:<repo>` and `size:<size>`;
- depending on the ids created for its `dependsOnIndex` entries;
- with its `doneWhen` and `proofKind`.

Applying the same file twice creates the punches twice.

## After apply

A draft whose dependencies have all closed is moved to `ready` by the loop on its next tick. A draft
with no dependencies waits for you: run `mandrel-loop ready <task-id>` when you want it built.

## Example

`spec.md`:

```markdown
# Spec: `greet` command

Add a `greet <name>` subcommand to the CLI that prints `Hello, <name>!`.
With no name it prints a usage line and exits 2.
Document it in the README.
```

A `punches.json` that `plan` could produce for it, and that lints clean:

```json
[
  {
    "title": "Add the greet function and its test",
    "description": "Add src/greet.ts exporting greet(name) and test/greet.test.ts covering it.",
    "size": "xs",
    "repo": "my-repo",
    "dependsOnIndex": [],
    "doneWhen": [
      { "text": "greet(\"Ada\") returns \"Hello, Ada!\"", "owner": "lane", "proof": "test/greet.test.ts" }
    ],
    "proofKind": "test"
  },
  {
    "title": "Wire greet into the CLI",
    "description": "Add the greet subcommand to src/cli.ts and test/cli-greet.test.ts.",
    "size": "s",
    "repo": "my-repo",
    "dependsOnIndex": [0],
    "doneWhen": [
      { "text": "`cli greet Ada` prints Hello, Ada! and exits 0", "owner": "lane", "proof": "test/cli-greet.test.ts" },
      { "text": "`cli greet` with no name prints a usage line and exits 2", "owner": "lane", "proof": "test/cli-greet.test.ts" }
    ],
    "proofKind": "test"
  },
  {
    "title": "Document the greet command",
    "description": "Describe greet in README.md.",
    "size": "xs",
    "repo": "my-repo",
    "dependsOnIndex": [1],
    "doneWhen": [
      { "text": "README.md shows greet with an example", "owner": "lane", "proof": "walkthrough evidence (not committed to the repo)" },
      { "text": "the wording reads well to the maintainer", "owner": "human" }
    ],
    "proofKind": "look"
  }
]
```

```console
$ mandrel-loop lint punches.json
lint: clean
$ mandrel-loop plan --apply punches.json
db24445c-f1e2-4992-a2b2-7030f91931e8 Add the greet function and its test
08df3f55-53a6-49ca-ae3c-8b71b1dda223 Wire greet into the CLI
cb628b6c-8215-42ee-855a-5064df37b2fc Document the greet command
applied: 3 draft(s)
```

The ids are whatever your board assigns. The first punch has no dependencies, so start the chain with
`mandrel-loop ready db24445c-f1e2-4992-a2b2-7030f91931e8`. The second becomes `ready` once the first
closes, and the third once the second closes.

A file that breaks the rules is refused. Here the first punch depends on a later one, has a `lane`
clause without a proof, names `systemctl`, uses an absolute path, and cites a test that only the
second punch creates:

```console
$ mandrel-loop lint bad.json
punch 0: [dependency] dependsOnIndex 1 must name an earlier punch (0..-1)
punch 0 clause 0: [missing-proof] owner:lane clause has no proof
punch 0 clause 0: [banned-word] text contains banned word "systemctl"
punch 0 clause 1: [rooted-path] text contains rooted path "/tmp/greet.log"
punch 0 clause 1: [proof-created-later] proof "test/cli-greet.test.ts" is only created by punch 1, which comes after punch 0; keep the code and its test in one punch
lint: 5 violation(s)
```
