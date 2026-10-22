# Mandrel

**Structured, persistent memory for AI coding agents — a typed knowledge graph that remembers the _story_ of your work, not just its text.**

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Protocol-orange)
![Status](https://img.shields.io/badge/Status-Production-green)

Most "AI memory" is a vector store: dump text, retrieve by similarity. Mandrel is
different. It gives AI agents a **typed-edge knowledge graph** over everything they
learn — decisions, context, tasks, lessons — automatically threaded into the story of
how a project actually evolved, and replayable on demand. When an agent comes back
tomorrow, it doesn't just find _relevant snippets_; it can walk the causal chain: what
was decided, why, what it superseded, what broke, and what fixed it.

Mandrel connects to any MCP-compatible agent (Claude, and others) and runs in
production today across isolated multi-tenant deployments.

---

## The problem

Every AI-assisted development session starts from zero. Your AI assistant doesn't
remember:

- Why you chose React Query over SWR last week
- That you already debugged this exact error three days ago
- The architectural decisions that shaped your codebase
- The conventions your team established

So you re-explain context, re-justify decisions, and re-solve problems. Worse: the
context window fills with repetitive background instead of forward progress — and with
agent swarms running in parallel, that lost thread compounds across every session.

Bolting a vector database onto an agent helps a little — you can retrieve _similar_
text. But similarity isn't memory. It can't tell you that decision B **superseded**
decision A, that this bug was **caused by** that change, or replay the sequence of moves
that got you here. That structure is what agents actually need to stay coherent across
time.

---

## What makes Mandrel different — Treewalker

Treewalker is the core: a memory model built as a **graph**, not a bucket. Three things
no vector store gives you:

**1. A typed-edge knowledge graph.**
Records link with real, queryable relationships — `decided_by`, `caused`, `supersedes`,
`learned_from`, `informs`, `related_to`, … — not just cosine proximity. You can traverse
_why_, not just _what's nearby_. Contexts, decisions, and tasks are all first-class nodes
in one graph.

**2. Deterministic auto-threading — honesty-gated.**
Set an active task or decision as the "thread," and every new capture is automatically
wired onto it — but **only when it genuinely belongs** (an embedding-similarity floor plus
an anchor TTL). Below the bar, Mandrel surfaces a _skip_ with the reason instead of
silently mis-filing. The guarantee is **no silent orphan and no silent mis-thread**: every
record ends with either a real edge or a stated reason. Memory you can trust is memory that
refuses to lie about its own structure.

**3. Story recall with trust signals.**
`recall_thread` replays the full narrative of any piece of work — the decisions, the
context, the fixes, in order. Each node carries a **trust signal** (proven vs. unproven),
so an agent knows which memories to lean on and which to re-verify. This is how a
cold-started agent resumes _exactly_ where the last one left off — lossless, not lossy.

This is the moat. Semantic retrieval is a commodity; a disciplined, self-honest,
replayable project graph is not.

---

## Context is the scarce resource

Exposing a large tool surface to an agent is expensive — every tool schema costs tokens on
every connection. Mandrel's **gateway** collapses its full tool surface behind a single
`discover` entrypoint plus a handful of action-discriminated gateways, so an agent loads
the capabilities it needs on demand instead of paying for all of them up front.

> **Result:** the 11-tool gateway serves its `tools/list` in **~1,330 tokens**, versus
> **~22,800** for the equivalent 57-tool flat surface — a **~94% reduction** (measured with
> our own token meter, `o200k_base`; still ~90% even if you strip output schemas from the
> flat baseline). First-call parity with the flat surface is verified.

Combined with local embeddings (below), the practical effect is: **more of the agent's
context window spent on your problem, less on plumbing.**

---

## Proven in production

- **Multi-tenant, isolated.** Each tenant runs its own containerized deployment (own
  database, own MCP server) behind a reverse proxy — not a shared multi-tenant table.
- **Dogfooded end-to-end.** Mandrel is built _using_ Mandrel. Every decision, lesson, and
  handoff in its own development lives in its graph — including the rebuild that produced
  the gateway above.
- **Local embeddings, zero API cost.** Semantic search runs on-device; no data leaves the
  box for embedding, and there's no per-query bill.
- **Fail-closed operations.** Health-gated rolling deploys, per-tenant secret isolation,
  and canary-first change management.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Client Layer                            │
├───────────────────────────────┬──────────────────────────────────┤
│      MCP Agents (Claude, …)    │        Web Dashboard             │
│   streamable HTTP / STDIO      │      (React + Vite)              │
└───────────────┬────────────────┴───────────────┬──────────────────┘
                │                                │
                ▼                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                         MCP Server (TypeScript)                  │
│  • Gateway surface — `discover` + action gateways (token-lean)   │
│  • Flat surface — per-tool endpoints (full, direct)              │
│  • Treewalker — typed-edge graph, auto-threading, recall_thread  │
└───────────────┬──────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  Services:  Embeddings (Transformers.js, 384D, local)            │
│             Session tracking · resilience · analytics            │
└───────────────┬──────────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  PostgreSQL + pgvector                                           │
│  contexts · technical_decisions · tasks · projects · sessions    │
│  + typed-edge graph over contexts / decisions / tasks            │
└──────────────────────────────────────────────────────────────────┘
```

### Key technical decisions

- **Local embeddings** — [Transformers.js](https://github.com/xenova/transformers.js) with
  `all-MiniLM-L6-v2` (384-dimensional vectors) runs inference locally: zero API cost, data
  stays on-box, works offline.
- **Two tool surfaces, one server** — a token-lean **gateway** (`discover` + action
  gateways) for MCP-protocol clients, and a **flat** per-tool surface for direct/tooling
  use. Same server, same data.
- **Graph-native memory** — the typed-edge graph, auto-threading, and `recall_thread` are
  first-class, not a plugin. Trust signals and threading are enforced at write time.

---

## Quick start

Prerequisite: a container runtime with compose —
Linux: [Docker Engine](https://docs.docker.com/engine/install/);
macOS: [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/). On Linux, also complete the
[post-install step](https://docs.docker.com/engine/install/linux-postinstall/) that adds your user
to the `docker` group (`sudo usermod -aG docker "$USER"`, then log out and back in). The stack runs
its own PostgreSQL 15 (with pgvector) in a container — nothing to install on the host.

```bash
git clone https://github.com/RidgetopAi/mandrel-oss.git
cd mandrel-oss
./install.sh
```

`install.sh` creates `.env` (mode 600) with a generated database password and MCP bearer
token, builds and starts the whole stack (PostgreSQL + pgvector, Redis, the MCP server and the
dashboard), waits until every service is healthy, validates the install, and prints the MCP
endpoint, the dashboard URL with a generated admin login (username and password, kept in `.env`),
and copy-pasteable MCP client configs carrying your token and an `X-Actor-ID` header (your login
name by default; override with `MANDREL_ACTOR_ID`). The MCP server advertises the small gateway
tool surface by default (`MANDREL_TOOL_SURFACE=gateway`). Re-running keeps your existing `.env`
values, including the admin password.

The full **[user manual](docs/manual/index.md)** covers install, connecting an agent, concepts,
everyday use, supersession and operations. Developing Mandrel itself (host `npm run dev:*`)? See
[CONTRIBUTING.md](CONTRIBUTING.md).

### Supersession (optional)

Mandrel can adjudicate whether a newly stored record **supersedes** or contests an older one
(it adds a soft `possibly_supersedes` edge and the old record's trust drops, so retrieval prefers what is true now). It calls an LLM, so it is
**off when no key is set** — a fresh install runs fine without it and logs one info line at
startup naming the variable that turns it on.

- **Container stack:** supersession is off until you enable it. Exact, copy-pasteable settings for
  the recommended Snap + Anthropic tiered setup (Snap is a public-preview API; its pricing may change before general availability), Snap only, Anthropic only, a local or smaller model (openai-compat, Ollama) and the daily spend cap (`MANDREL_BELIEF_DAILY_SPEND_CAP_USD`, default `2`) are in
  [docs/manual/supersession.md](docs/manual/supersession.md); every setting is in the
  [configuration reference](docs/reference/configuration.md).
- **Explicit control:** `MANDREL_BELIEF_ENABLED=false` forces it off even with a key.
  `MANDREL_BELIEF_ENABLED=true` with no credential logs one `DISARMED` error and stays off.

See the commented block in `.env.example`.

### Verify

`install.sh` already runs this; run it again any time:

```bash
./scripts/validate-install.sh      # runs inside the containers — no host psql needed
curl http://localhost:8080/health
# -> {"status":"healthy","timestamp":"...","uptime":12.3,"pid":1,"version":"<semver>+<revision>","embeddings":"real"}
```

`embeddings` is `real` for a working install; `mock` means the server is serving meaningless
vectors and the validator fails.

Connect your agent to the MCP endpoint and start with `mandrel_help` (flat) or
`discover({action:'catalog'})` (gateway) to see the full tool catalog.

---

## MCP tools

Mandrel exposes a broad tool surface organized by category — system health, navigation,
projects, semantic **context** storage, architectural **decisions**, **tasks**,
**smart search**, and the **linking & graph** tools that power Treewalker (`link`,
`get_links`, `recall_thread`, `thread_set`/`thread_current`/`thread_clear`).

Protocol clients navigate the token-lean gateway: `discover({action:'catalog'})` to list,
`discover({action:'explain', tool})` for a tool's contract, then call the relevant gateway
(e.g. `context({action:'store', …})`).

### Example — store a learning

```typescript
context_store({
  content: "pgbouncer dropped idle connections after 30s under load; fixed with " +
           "server_idle_timeout=600. Symptom was 'connection reset' errors.",
  type: "error",
  tags: ["postgresql", "pgbouncer", "connection-pooling"]
})
// With an active thread set, this auto-links onto the current task/decision —
// or surfaces a 'skip' with a reason if it doesn't belong. No silent mis-filing.
```

### Example — replay the story

```typescript
recall_thread({ /* task or decision */ })
// Returns the ordered narrative: the decision, what informed it, what it
// superseded, the lessons learned — each node with its trust signal.
```

---

## Technology stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| MCP Server | TypeScript, Node.js | Protocol + graph engine |
| Database | PostgreSQL 15 + pgvector | Storage + vector search + typed-edge graph |
| Embeddings | Transformers.js (`all-MiniLM-L6-v2`) | 384D semantic vectors, local inference |
| Dashboard | React, Vite | Developer UI |
| API | Express.js | REST + session analytics |
| Validation | Zod | Runtime schema validation |
| Testing | Vitest | Unit + integration |

---

## The Punch List loop

Mandrel ships a reference loop that works the punches on your board with a coding agent and an
independent critic. To install and run it, see [loop/README.md](loop/README.md).

---

## Status

Mandrel is production-deployed with health-gated rolling deploys and per-tenant isolation.
It is under active development toward general availability.

---

## License

See [LICENSE](LICENSE).

---

Built by [RidgetopAI](https://github.com/RidgetopAi) to make AI-assisted development
sustainable across sessions, agents, and time.
