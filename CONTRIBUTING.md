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
npm run setup
docker compose up -d postgres redis
npm run migrate
npm run dev:mcp             # MCP server
npm run dev:command         # Dashboard
```
