# Concepts

## Projects

A **project** is the container for everything that belongs together — usually one codebase.
Contexts, decisions and tasks always live in exactly one project, and searches stay inside it, so a
note about one repository never leaks into another. Each connection has a *current project*:
`project({action:"list"})`, `project({action:"create", name:"my-app"})`,
`project({action:"switch", project:"my-app"})`, `project({action:"current"})`. Agents can be bound to
one project up front with the `X-Mandrel-Project` header
([Connect an agent](connect-an-agent.md#the-headers)).

## Contexts

A **context** is one stored piece of knowledge: text plus a type, tags and a semantic embedding, so
you can find it by meaning later. The type says what kind of note it is:

| Type | Use it for |
| --- | --- |
| `code` | a snippet or a how-it-works explanation |
| `decision` | a decision mentioned in passing (formal ones use the decision tools) |
| `error` | a failure and what fixed it |
| `discussion` | the outcome of a conversation |
| `planning` | a plan or approach |
| `completion` | a finished feature or fix |
| `milestone` | a major achievement |
| `reflections` | what you would do differently |
| `handoff` | a baton for the next session — see [Everyday use](everyday-use.md#resume-a-session-from-a-handoff) |
| `lessons` | something learned the hard way |
| `note` | anything else (there is no `fact` type) |

Tags categorise and can also **link**: a tag like `task:<id8>` or `decision:<id8>` wires the context
into that record's story.

## Decisions

A **decision** is a structured record of a technical choice: title, what was decided, rationale,
alternatives considered, impact level and (recommended) success criteria to check later. Its
`decisionType` is one of architecture, library, framework, pattern, api_design, database,
deployment, security, performance, ui_ux, testing, tooling, process, naming_convention or
code_style. Decisions are updated as outcomes become known, which is how the system learns what
worked.

## Tasks

A **task** is a unit of work with a title, a `type` (feature, bug, bugfix, refactor, test, review,
docs, documentation, devops, general), a `priority` (low, medium, high, urgent) and a `status`
(todo, in_progress, completed, blocked, cancelled). Tasks can be listed, updated, bulk-updated and summarised.
They can be claimed with a lease so two workers do not take the same one. The reference loop
(`mandrel-loop`) requires task claims, so they are on by default in the bundled install
(`MANDREL_TASK_CLAIM_ENABLED=true`); set it to `false` in `.env` only if you do not run the loop,
and note that `mandrel-loop doctor` fails while claims are off.

## The typed-edge graph

Records link to each other through **typed edges**. The vocabulary is: `decided_by`, `caused`,
`built_by`, `supersedes`, `possibly_supersedes`, `learned_from`, `proposed_by`, `informs`,
`produced_outcome`, `depends_on`, `subtask_of`, `related_to`. You can add edges explicitly with
`graph({action:"link", ...})` or in the same call that stores a record via its `links` argument
(`{"task":"<id8>"}` is shorthand for an `informs` edge to a task). The server also threads new
records onto the thread you are working on, or tells you why it skipped; nothing is filed silently
in the wrong place.

## Branches, positions and threads

Where you are working in the graph is a **position**. `graph({action:"branch_open", id:"<id8>"})`
stands you on a record (a task, decision or context, by its 8-hex short id or full UUID); while open,
whatever you store is automatically linked to it with an `informs` edge. Claiming a task or moving it
to `in_progress` opens its branch for you. Handoffs are always trunk records, never branch members.
`graph({action:"branch_current"})` shows where you stand, `branch_close` leaves.
The older `thread_set` / `thread_current` / `thread_clear` actions are deprecated aliases of
`branch_open` / `branch_current` / `branch_close`; use the `branch_*` names.

## recall_thread

`recall_thread` replays the story of one record. Give it an anchor (a `ref:<slug>` tag, or a
context/decision/task id8) and it walks the graph in both directions, orders the nodes so they read
top to bottom, attaches a trust signal to each, and lists what to be wary of. It uses no LLM.
Altitudes: `headline`, `summary` (default), `full`, and `current` — a bounded present-state view
(active tasks, open blockers, standing decisions, the recommended next action) with superseded
nodes counted but left out.

## Trust and supersession

Every node in a recalled thread carries a trust signal, and when the server can't judge it says it
abstains rather than guess. The biggest factor is **supersession**: when a newer record replaces an
older one, a `supersedes` edge (or, when the server's adjudicator is the one deciding, a soft `possibly_supersedes` edge that demotes the old record's trust) marks the old one as outdated and retrieval prefers the new one.
The server can detect this for you by asking an LLM to compare each new record with its nearest
neighbours — optional, off by default: [Supersession](supersession.md).

## Sessions and actors

A **session** is one stretch of work. The **actor** is *who* is working (the `X-Actor-ID` header);
identity follows the actor, not the TCP connection, so a reconnect lands in the same place. By
default the server runs in a compatible `legacy` mode keyed by connection; the settings that move
it to actor-based resolution (`MANDREL_SESSION_RESOLVER_MODE`, `MANDREL_SESSION_REQUIRE_ACTOR`) are in
[Sessions & identity](../reference/configuration.md#sessions--identity). Sessions are created for
you on the first write; you never have to start one.
