# Connect an agent

Mandrel speaks MCP over HTTP at `http://localhost:8080/mcp` (the *streamable HTTP* transport).
Every request must carry the bearer token `install.sh` generated. The token is the value of
`MCP_AUTH_TOKEN` in the `.env` file at the root of your clone:

```bash
grep '^MCP_AUTH_TOKEN=' .env
```

## Claude Code

You need Claude Code installed first; follow the official install page,
<https://docs.claude.com/en/docs/claude-code/setup>, then check `claude --version`.

`install.sh` prints a ready-made command. It looks like this (token and actor are yours):

```bash
claude mcp add --transport http mandrel http://localhost:8080/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  --header "X-Actor-ID: <your-name>"
```

Or put the same thing in `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "mandrel": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>",
        "X-Actor-ID": "<your-name>"
      }
    }
  }
}
```

Start Claude Code and run `/mcp`; `mandrel` should be listed as connected. Then ask it to call
`discover` with `{action:"ping"}`.

## Any other MCP client

Any client that supports the streamable HTTP transport works. Give it:

- URL: `http://localhost:8080/mcp`
- Header `Authorization: Bearer <MCP_AUTH_TOKEN>`
- Optionally the headers below.

A client that only speaks stdio can reach the endpoint through a stdio-to-HTTP bridge such as
`npx mcp-remote http://localhost:8080/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`.

If you will reach Mandrel under a name other than `localhost` or `127.0.0.1`, add that host name to
`MCP_ALLOWED_HOSTS` in `.env` and run `docker compose up -d`; requests for unlisted hosts are
refused. Letting web clients (for example claude.ai) connect without the static token needs the
built-in OAuth server (`MANDREL_OAUTH_ENABLED`, see
[server & auth settings](../reference/configuration.md#server--auth)).

## The headers

| Header | What it is for |
| --- | --- |
| `Authorization: Bearer <token>` | Required. Proves the caller may use this server. |
| `X-Actor-ID` | Who is writing: a person or agent name. Everything stored is attributed to it, and sessions follow the actor. Without it writes are recorded as `anonymous`. `install.sh` fills in your login name; change it with `MANDREL_ACTOR_ID` in `.env` before installing, or edit the header. |
| `X-Connection-ID` | Optional. A stable id you choose for this client. Sessions and the current project are keyed to it, so they survive a server restart. Without it the server falls back to the per-connection `mcp-session-id`, which changes on every reconnect. |
| `X-Mandrel-Project` | Optional. A project name or id this client is bound to. A bound client starts in that project and stays there; a call naming a different project fails loudly instead of writing to the wrong place. Recommended for autonomous agents. |

Example with all four:

```json
"headers": {
  "Authorization": "Bearer <MCP_AUTH_TOKEN>",
  "X-Actor-ID": "ci-agent",
  "X-Connection-ID": "ci-agent-main",
  "X-Mandrel-Project": "my-app"
}
```

How sessions and actors fit together is described in [Concepts](concepts.md#sessions-and-actors).
The sessions-related settings are under
[Sessions & identity](../reference/configuration.md#sessions--identity).

## Gateway vs flat tool surface

The server can advertise its tools two ways, chosen by `MANDREL_TOOL_SURFACE`:

- **`gateway`** (the default `install.sh` stack): a handful of tools — `discover`, `session`,
  `context`, `project`, `decision`, `task`, `graph` — each taking an `action`, plus the
  flat `recall_thread`, `smart_search` and `get_recommendations`. This keeps the tool list small
  (it costs your agent far fewer tokens). Example call: `context({action:"store", ...})`.
  Start with `discover({action:"catalog"})` to list everything and
  `discover({action:"explain", tool:"context_store"})` for one tool's contract.
- **`legacy`**: every operation is its own tool (`context_store`, `decision_record`, ...).

With the gateway surface, the individual tool names are still accepted when
`MANDREL_FLAT_TOOLS=accept` (the default). Both surfaces read and write the same data. To change
surface, set `MANDREL_TOOL_SURFACE` in `.env` and run `docker compose up -d`; it is
passed through by the compose file.
