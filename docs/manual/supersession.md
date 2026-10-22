# Supersession

## What it does

Knowledge goes out of date. Supersession asks a language model to compare each newly stored context or
decision with its most similar older records in the same project. When the new one replaces an old
one, Mandrel records that as a soft `possibly_supersedes` edge from the new record to the old one, and retrieval (including [`recall_thread`](concepts.md#recall_thread))
prefers what is true now. You will see the old record's trust score drop (it is demoted, not hidden: it is
still returned, flagged and ranked below its peers) and it is counted instead of being presented as current.
A hard `supersedes` edge is only created by a person or an explicit link call.

It runs in the background after a store, so storing never waits for it. It needs an LLM, so:

- It is **off in the container stack until you turn it on**. A fresh install runs completely without
  it, calls no model and costs nothing.
- The settings are listed in the
  [supersession settings reference](../reference/configuration.md#supersession-belief).

## How to apply the settings

The container stack's `docker-compose.yml` forwards only a few supersession variables from `.env` by
itself (`SUBQ_API_KEY`, `ANTHROPIC_API_KEY`, `MANDREL_BELIEF_ENABLED`, `MANDREL_BELIEF_ADJUDICATOR_PROVIDER`
and `MANDREL_BELIEF_DAILY_SPEND_CAP_USD`). To set the rest, create a file named
`docker-compose.override.yml` next to `docker-compose.yml`. Compose merges it automatically, and
`install.sh` and every `docker compose` command pick it up. API keys go in `.env` (mode 600, never
committed); the override file refers to them as `${NAME}`.

After creating or changing either file, apply it:

```bash
docker compose up -d
docker compose logs mcp-server | grep -i belief
```

The log shows one line saying whether supersession armed, or a single `DISARMED` error naming what
is missing (for example a key variable that is empty).

## Off (no key)

This is the default; nothing to do. To state it explicitly, put this in `.env`:

```bash
MANDREL_BELIEF_ENABLED=false
```

`MANDREL_BELIEF_ENABLED=false` forces it off even if you later add a key.

## Recommended: Snap + Anthropic (tiered)

Set both keys and supersession runs in two tiers: a deterministic decision model first, a reasoning
model only when needed. Tier 1, [SubQ Snap](https://subq.ai) (`SUBQ_API_KEY`), judges every candidate
pair cheaply and consistently. Tier 2, Anthropic Sonnet (`ANTHROPIC_API_KEY`), reasons only about the
pairs Snap flags as `supersedes` or `contests` (set by `MANDREL_BELIEF_TIERED_ESCALATE_VERDICTS`), so
most pairs never pay the reasoning-model price.

Snap is a **public-preview** API: its pricing may change before general availability, so check the
current preview pricing before relying on it. The daily spend cap below bounds what you can be charged
either way.

In `.env`:

```bash
SUBQ_API_KEY=<your SubQ API key>
ANTHROPIC_API_KEY=<your Anthropic API key>
```

Nothing else is needed: with `MANDREL_BELIEF_ADJUDICATOR_PROVIDER` unset the keys select tiered mode.
If you set `MANDREL_BELIEF_ADJUDICATOR_PROVIDER=tiered` yourself and a key is missing, the server
disarms with one error naming it.

## Other options

### Snap only

Set only `SUBQ_API_KEY`. Snap judges every pair on its own (single-tier `subq`), with no reasoning
tier: the lowest cost, but nothing double-checks a `supersedes` verdict. Snap is in public preview and
its pricing may change before general availability.

### Anthropic only

Set only `ANTHROPIC_API_KEY`. Every pair goes to Sonnet (single-tier `anthropic`): simple, but higher
cost than tiered, bounded by the daily spend cap. Adding a Snap key later lowers the cost. To pin the
model, put this in `docker-compose.override.yml`:

```yaml
services:
  mcp-server:
    environment:
      MANDREL_BELIEF_ENABLED: "true"
      MANDREL_BELIEF_ADJUDICATOR_PROVIDER: "anthropic"
      MANDREL_BELIEF_ADJUDICATOR_MODEL: "claude-sonnet-5"
      MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV: "ANTHROPIC_API_KEY"
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
```

`MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV` is the *name* of the variable holding the key, not the key.

### A local or smaller model (openai-compat)

Any server that speaks an OpenAI-style chat API (llama.cpp, vLLM, LM Studio, or a hosted small model)
works through the `openai-compat` provider. In `docker-compose.override.yml`:

```yaml
services:
  mcp-server:
    environment:
      MANDREL_BELIEF_ENABLED: "true"
      MANDREL_BELIEF_ADJUDICATOR_PROVIDER: "openai-compat"
      MANDREL_BELIEF_ADJUDICATOR_MODEL: "<the model name the server serves>"
      MANDREL_BELIEF_ADJUDICATOR_ENDPOINT: "http://host.docker.internal:<port>"
      MANDREL_BELIEF_ADJUDICATOR_API_KEY_ENV: "OPENAI_API_KEY"
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
```

From inside the container the host is `host.docker.internal`. The key variable must still hold a
non-empty value; a server that does not check keys ignores it. If the server rejects the `top_k`
field, set `MANDREL_BELIEF_ADJUDICATOR_SEND_TOP_K` to `false`. (The llama.cpp variant has not been
exercised by this manual's author.) For a model that needs no key at all, see Ollama below.

## Ollama (local, no key)

A model running on your own machine through [Ollama](https://ollama.com); nothing leaves the box
and no key is involved. Because a keyless provider cannot be detected automatically, you must
turn it on explicitly with `MANDREL_BELIEF_ENABLED=true`. First pull a model on the host
(`ollama pull qwen2.5:7b`; pick one that follows structured-output instructions well), and make
Ollama listen where the container can reach it (`OLLAMA_HOST=0.0.0.0` in Ollama's environment —
by default it listens on the loopback only, which the container cannot see).

`docker-compose.override.yml`:

```yaml
services:
  mcp-server:
    environment:
      MANDREL_BELIEF_ENABLED: "true"
      MANDREL_BELIEF_ADJUDICATOR_PROVIDER: "ollama"
      MANDREL_BELIEF_ADJUDICATOR_MODEL: "qwen2.5:7b"
      MANDREL_BELIEF_ADJUDICATOR_ENDPOINT: "http://host.docker.internal:11434"
      MANDREL_BELIEF_ADJUDICATOR_KEEP_ALIVE: "10m"
      MANDREL_BELIEF_ADJUDICATOR_TIMEOUT_MS: "120000"
```

`host.docker.internal` resolves to the host from inside the container (the compose file maps it).

## Cost and safety

- `MANDREL_BELIEF_COST_ALERT_USD_PER_DAY` (default `5`) is the daily spend above which the cost
  report raises a loud alert. The hard stop is the daily spend cap, below.
- `MANDREL_BELIEF_PAIR_TOP_K` (default `8`) bounds how many neighbours each new record is compared with,
  and `MANDREL_BELIEF_QUEUE_MAX_DEPTH` bounds the backlog.
- Only the text of records (cut to `MANDREL_BELIEF_ADJUDICATOR_MAX_CONTENT_CHARS`) is sent to a hosted
  provider. Use Ollama if records must not leave your machine.
- A failed model call never loses or blocks the stored record; it is skipped and logged.

## The daily spend cap

`MANDREL_BELIEF_DAILY_SPEND_CAP_USD` is a hard ceiling on what paid supersession calls may cost in one
UTC day. Its default is `2` (dollars); `0` means no cap. Change it in `.env`:

```bash
MANDREL_BELIEF_DAILY_SPEND_CAP_USD=5
```

Then run `docker compose up -d`.

When today's recorded cost reaches the cap, no further paid call is made: the pair is skipped and
logged. **Writes keep working** — storing a context or decision never fails or waits because of the
cap. Supersession pauses and resumes by itself at the start of the next UTC day. Pairs skipped while
paused are not retroactively judged.

To see today's spend, run `bash scripts/belief-cost.sh` (add `--json` for machine-readable output); it runs inside the
mcp-server container (no extra tooling needed) and reads the append-only cost ledger. It prints
today's spend, the daily cap and whether the cap is reached, plus dollars, calls and tokens per day
and per provider. A pair skipped because of the cap is logged as a skip with the cap and today's total.
`install.sh` also prints the cap it will run with.
