# Contributing

Contributions are welcome. Full contributing guidelines are coming; until then, open an issue to discuss a change before sending a pull request, and run `bash scripts/oss-gate.sh` before you submit.

## Developing Mandrel

Users install with `./install.sh` (see the README). To work on Mandrel itself you run the
services from source on the host. Prerequisites: Node.js 18+ and a container runtime with compose
(for PostgreSQL 16 + pgvector and Redis).

```bash
git clone https://github.com/RidgetopAi/mandrel-oss.git
cd mandrel-oss
cp .env.example .env        # then set POSTGRES_PASSWORD (any value) in .env
# Pin the dev PostgreSQL and Redis to fixed host ports no host install uses:
printf 'MANDREL_POSTGRES_HOST_PORT=55432\nMANDREL_REDIS_HOST_PORT=56379\n' >> .env
# ...and point the services you run on the host at them (an exported variable wins over
# any .env file they read):
export DATABASE_PORT=55432 REDIS_URL=redis://localhost:56379 REDIS_PORT=56379
npm run setup
docker compose up -d postgres redis
npm run migrate
npm run dev:mcp             # MCP server
npm run dev:command         # Dashboard
```

The container stack gives PostgreSQL and Redis no fixed host port unless you pin them. Skip the
two pinning steps and `npm run migrate` either finds nothing on 5432 or, if you already run
PostgreSQL on the host, migrates that database instead.
