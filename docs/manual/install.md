# Install

There is one supported install path: the container stack, started by `install.sh`. (Developing
Mandrel itself on the host with `npm run dev:*` is a different thing; see
[CONTRIBUTING.md](../../CONTRIBUTING.md).)

## Prerequisites

You need a container runtime **with the compose plugin**. Nothing else: PostgreSQL, Redis, Node and
the embedding model all run inside containers.

### Linux

Install Docker Engine following <https://docs.docker.com/engine/install/> for your distribution
(this includes the compose plugin). Then let your user talk to the Docker daemon without `sudo`:

```bash
sudo usermod -aG docker "$USER"
```

Log out and back in (or reboot) so the new group applies, then check:

```bash
docker info
docker compose version
```

The post-install steps are described at <https://docs.docker.com/engine/install/linux-postinstall/>.

### macOS and Windows

Install Docker Desktop (<https://docs.docker.com/desktop/>), start it, and wait until it reports
that it is running. Compose is included.

## Install Mandrel

```bash
git clone https://github.com/RidgetopAi/mandrel-oss.git && cd mandrel-oss && ./install.sh
```

The first run builds the images and can take several minutes.

### What `install.sh` does

In order:

1. Checks that the container runtime and its compose plugin exist and that your user can use them.
2. Creates `.env` (mode 600) from `.env.example` on first run, with a generated
   `POSTGRES_PASSWORD`, a generated `MCP_AUTH_TOKEN` (the bearer token your agent uses), the
   `MCP_ALLOWED_HOSTS` list (`localhost,127.0.0.1`) and a generated dashboard admin login. Re-running
   keeps every value already in `.env`.
3. Builds and starts the stack from `docker-compose.yml`: PostgreSQL with pgvector, Redis, the MCP
   server and the dashboard (backend and frontend). It waits until every service is healthy
   (up to 900 seconds; `MANDREL_INSTALL_TIMEOUT` changes that).
4. Runs `scripts/validate-install.sh`.
5. Creates the dashboard admin user.
6. Prints which [supersession](supersession.md) mode the API keys in `.env` will produce (`tiered`
   with both `SUBQ_API_KEY` and `ANTHROPIC_API_KEY` — the recommended setup — `subq`, `anthropic` or
   `off`) and the daily spend cap (default `$2`). With only an Anthropic key it adds a line saying a
   Snap key lowers cost. Key values are never printed.
7. Prints how to connect.

The ending of its output has this shape (your token, actor name and password differ):

```text
Mandrel is running.

  MCP endpoint : http://localhost:8080/mcp
  Dashboard    : http://localhost:3000
  Dashboard login:  username admin   password <generated>   (kept in /path/to/mandrel-oss/.env)

Connect Claude Code (run this once):

  claude mcp add --transport http mandrel http://localhost:8080/mcp --header "Authorization: Bearer <token>" --header "X-Actor-ID: <you>"
```

What the host ports are, and the `.env` setting that moves each:

| Port | Service | Setting |
| --- | --- | --- |
| 8080 | MCP server (`/mcp`) and `/health` | `MANDREL_MCP_HOST_PORT` |
| 3000 | dashboard | `MANDREL_DASHBOARD_HOST_PORT` |
| 5000 | dashboard backend (REST API) | `MANDREL_DASHBOARD_API_HOST_PORT` |
| none | PostgreSQL | `MANDREL_POSTGRES_HOST_PORT` |
| none | Redis | `MANDREL_REDIS_HOST_PORT` |

All of them are bound to `127.0.0.1` only; nothing is exposed to your network. PostgreSQL and
Redis have no fixed host port unless you set one: the installed stack never reaches them from
the host, and a database or Redis you already run on 5432 or 6379 never conflicts. Host tools
(psql, redis-cli, services run from source) need one: set the setting above. (Docker still gives each a
random `127.0.0.1` port; `docker compose port postgres 5432` shows it.) `install.sh` prints the
MCP endpoint and dashboard URL on whichever ports are in use.

## Verify

`install.sh` already ran these; run them again whenever you like.

```bash
./scripts/validate-install.sh
```

It runs everything inside the containers (no host `psql`, `curl` or `node` needed). A good run prints
`[ok]` lines for the container runtime, `.env`, `MCP_AUTH_TOKEN`, PostgreSQL, the extensions
`vector`, `pg_trgm`, `pgcrypto` and `uuid-ossp`, Redis, the MCP server's `/health`, and
`embeddings are real`, and ends with `All checks passed.` A failed check prints `[FAIL]` and a
`hint:` line naming the next thing to look at.

Ask the server directly:

```bash
curl http://localhost:8080/health
```

```json
{"status":"healthy","timestamp":"...","uptime":12.3,"pid":1,"version":"<semver>+<revision>","embeddings":"real"}
```

`embeddings` must be `real`. `mock` means the server is returning meaningless vectors and search
would be useless; the validator fails on it.

Next: [connect an agent](connect-an-agent.md).

## Troubleshooting

### `'docker' was not found on PATH`, or `'docker compose' is not available`

The runtime or its compose plugin is missing. Install it as described under
[Prerequisites](#prerequisites). To use another runtime that has a compatible CLI, set
`MANDREL_RUNTIME` (for example `MANDREL_RUNTIME=podman ./install.sh`).

### `installed but this user cannot use it` / permission denied

Either the daemon is not running or your user may not talk to it. Start Docker, and on Linux add
yourself to the `docker` group and log in again:

```bash
sudo usermod -aG docker "$USER"
```

### A service never turns healthy

`install.sh` stops after the timeout and prints, for each unhealthy service:
`service "<name>" is not healthy after 900s. See why: docker compose logs <name>`. Run exactly that:

```bash
docker compose ps
docker compose logs --tail=100 mcp-server
```

The service names are `postgres`, `redis`, `mcp-server`, `mandrel-command-backend` and
`mandrel-command-frontend`. A slow machine on first build may only need a longer wait:
`MANDREL_INSTALL_TIMEOUT=1800 ./install.sh`. Re-running `install.sh` is safe.

### A port is already in use

`install.sh` checks every host port before it starts anything. If one is taken it stops and
prints, for each busy port, the service that needs it and the line to add to `.env`:

```text
install.sh: ERROR: host port 8080 (127.0.0.1) is already in use; Mandrel's mcp-server service needs it.
  See what holds it:  Linux: ss -ltnp 'sport = :8080'   macOS: lsof -nP -iTCP:8080 -sTCP:LISTEN
  Or move Mandrel's mcp-server: add this line to /path/to/mandrel-oss/.env and re-run ./install.sh:
      MANDREL_MCP_HOST_PORT=18080
```

Either stop the other program or add that line to `.env`, then re-run `./install.sh`. The installer
then prints the MCP endpoint on the new port and adds `localhost:<port>` and
`127.0.0.1:<port>` to `MCP_ALLOWED_HOSTS` (the server refuses a Host header it does not list,
port included; set them yourself if you start the stack by hand). An MCP client you configured
earlier needs the new URL. The older `TENANT_*_PORT` names still work; the `MANDREL_*_HOST_PORT` names win when both
are set. If the check reports a port busy that Docker can in fact bind, skip it with
`MANDREL_SKIP_PORT_CHECK=1 ./install.sh`.

### The install check reports mock embeddings

`validate-install.sh` fails with `server reports MOCK embeddings`. Real embeddings come from the local
model that is bundled into the server image; `mock` appears when that model could not be loaded.
Check `docker compose logs mcp-server` for the load error, make sure
`MANDREL_EMBEDDINGS_ALLOW_MOCK` is not set in `.env`, and rebuild with
`docker compose up -d --build`. See also `MANDREL_EMBEDDER` and `MANDREL_XENOVA_ALLOW_REMOTE` in the
[embeddings settings](../reference/configuration.md#embeddings).

### `localhost` does not connect (IPv6)

Some systems resolve `localhost` to the IPv6 address `::1`, while the stack publishes on
`127.0.0.1`. If `curl http://localhost:8080/health` hangs or is refused but
`curl http://127.0.0.1:8080/health` works, use `127.0.0.1` in your agent's config (and re-run the
installer with `MANDREL_MCP_URL=http://127.0.0.1:8080/mcp ./install.sh` to print it that way).
`127.0.0.1` is already in the allowed-host list.
