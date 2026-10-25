# Everyday use

These are worked examples of what your agent does, written as gateway calls (the default surface; see
[gateway vs flat](connect-an-agent.md#gateway-vs-flat-tool-surface)). You normally do not type
these yourself: tell your agent in plain language ("store that as a lesson", "what did we decide
about caching?") and it makes the calls. Use `discover({action:"explain", tool:"<name>"})` to see
any tool's exact contract, and `discover({action:"examples", tool:"<name>"})` for more patterns.

Replies are not reproduced here because they carry ids, timestamps and similarity scores that
differ on every server; each reply names the ids it created (short 8-hex ids such as `2b3c4d5e`),
which you use in the later calls.

## Choose a project

```text
project({action:"create", name:"my-app", description:"The billing service"})
project({action:"switch", project:"my-app"})
project({action:"current"})
```

## Store and recall

Store what you learned, with a type and tags:

```text
context({action:"store",
  content:"pgbouncer dropped idle connections after 30s under load; fixed with client_idle_timeout=600. Symptom was 'connection reset' errors.",
  type:"error",
  tags:["postgresql","pgbouncer"]})
```

Find it again by meaning, not exact words:

```text
context({action:"search", query:"why do database connections reset under load"})
context({action:"search", query:"connections", type:"error", limit:5})
context({action:"recent", limit:10})
```

Look up one record by id (full UUID or 8+ hex characters): `context({action:"search", id:"<id8>"})`.

## Record a decision

```text
decision({action:"record",
  decisionType:"database",
  title:"Use PgBouncer in transaction mode",
  description:"All services connect through PgBouncer with pool_mode=transaction.",
  rationale:"Connection counts exceeded Postgres limits during traffic spikes.",
  impactLevel:"medium",
  alternativesConsidered:[{name:"Raise max_connections", reasonRejected:"Memory cost per connection"}],
  successCriteria:"No 'too many connections' errors for 30 days"})
```

Later, when you know how it turned out, update it:
`decision({action:"update", decisionId:"<id8>", outcomeNotes:"...", ...})`
(see `discover({action:"explain", tool:"decision_update"})` for the fields).
Find decisions with `decision({action:"search", query:"connection pooling"})`.

## Track tasks

```text
task({action:"create", title:"Add idempotency keys to the billing webhook", type:"feature", priority:"high"})
task({action:"list", statuses:["todo","in_progress"]})
task({action:"update", taskId:"<id8>", status:"in_progress"})
task({action:"update", taskId:"<id8>", status:"completed", progress:100})
task({action:"progress"})
```

Moving a task to `in_progress` also opens its branch, so things you store while working on it
attach to it automatically ([Concepts](concepts.md#branches-positions-and-threads)). To tie a
record to a task explicitly, tag it `task:<id8>` or pass `links:[{"task":"<id8>"}]` when you
store it.

## Resume a session from a handoff

At the end of a stretch of work, store a `handoff` — the baton the next session reads first.
Say what mode you are in and what the next session resumes:

```text
context({action:"store", type:"handoff",
  content:"Webhook idempotency: keys table migrated; handler still needs the dedupe check. Do not touch the retry queue.",
  mode:"implement",
  spine:"<task id8>"})
```

The server tags it `ref:resume` for you so the newest one can always be found. A new session
starts by asking for the project briefing, which shows the latest handoff (its mode and the record it
resumes), open tasks and standing decisions:

```text
project({action:"briefing"})
graph({action:"branch_open", id:"<spine id8>"})
```

## Search

```text
context({action:"search", query:"idempotency"})           # contexts only
decision({action:"search", query:"idempotency"})          # decisions only
smart_search({query:"idempotency"})                       # across contexts, decisions and tasks
get_recommendations({context:"adding idempotency keys"}) # suggestions for the current project
recall_thread({anchor:"<id8>", altitude:"summary"})       # the story around one record
```

The dashboard at <http://localhost:3000> shows the same data for browsing.
