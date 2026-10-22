# Mandrel user manual

## What Mandrel is

Mandrel is a memory server for AI coding agents. Your agent (Claude Code, or any client that speaks
the [Model Context Protocol](https://modelcontextprotocol.io)) connects to Mandrel and uses it to
**store** what it learns, **record** the decisions it makes, **track** tasks, and **recall** all of
it later — in the next session, or next month. Everything lives in a PostgreSQL database on your
own machine, and the search that finds old notes runs locally too: no embeddings API, no cost.

What makes it more than a notes folder:

- Records are linked into a **graph** with typed edges (this task *informs* that decision, this
  note *supersedes* that one), so an agent can replay the *story* of a piece of work, not just a
  pile of search hits.
- Records carry **trust**: an outdated note is marked superseded and retrieval prefers what is true
  now. See [Supersession](supersession.md).
- A **handoff** note lets a fresh session pick up exactly where the last one stopped.

## A 2-minute tour

1. Install the stack (one command; Docker is the only prerequisite): [Install](install.md).

   ```bash
   git clone https://github.com/RidgetopAi/mandrel-oss.git && cd mandrel-oss && ./install.sh
   ```

2. Paste the `claude mcp add ...` line that `install.sh` prints:
   [Connect an agent](connect-an-agent.md).
3. Ask your agent to store something and find it again. Under the hood it calls:

   ```text
   context({action:"store", content:"Retries on the billing webhook must be idempotent.", type:"lessons", tags:["billing"]})
   context({action:"search", query:"webhook retries"})
   ```

   More examples: [Everyday use](everyday-use.md).
4. Open the dashboard at <http://localhost:3000> and log in with the username and password
   `install.sh` printed.

## Chapter map

| Chapter | Read it when |
| --- | --- |
| [Install](install.md) | You have not installed yet, or the install failed. |
| [Connect an agent](connect-an-agent.md) | You want Claude Code or another MCP client talking to Mandrel. |
| [Concepts](concepts.md) | You want to know what projects, contexts, decisions, tasks, the graph and trust mean. |
| [Everyday use](everyday-use.md) | You want worked examples: store, recall, decide, track, resume, search. |
| [Supersession](supersession.md) | You want outdated records detected automatically (needs an LLM). |
| [Operations](operations.md) | You are upgrading, backing up, reading logs or uninstalling. |

Every setting is listed in the [configuration reference](../reference/configuration.md).
