# Operations

Run every command here from the directory you cloned (`mandrel-oss`).

## Health

```bash
docker compose ps                         # every service should be running / healthy
curl http://localhost:8080/health         # {"status":"healthy",...,"embeddings":"real"}
./scripts/validate-install.sh             # the full check, run inside the containers
```

`/health` reports `version` as `<semver>+<git revision>`, which tells you which build is running.

## Logs

```bash
docker compose logs --tail=100 mcp-server
docker compose logs -f mcp-server         # follow
docker compose logs postgres redis mandrel-command-backend mandrel-command-frontend
```

Container logs are rotated by Docker. The server also writes log files in the `mcp_logs` volume
(`/app/logs` inside the container); verbosity comes from `LOG_LEVEL` in `.env`.

## Upgrading

```bash
git pull
./install.sh
```

`install.sh` is safe to re-run: it keeps your `.env` (including the token and passwords), rebuilds
the images from the new source, restarts the stack, waits for it to be healthy and validates it.
The server applies database migrations on start. **Back up first** (below), and read the release
notes in the repository for anything that needs your attention.

If you changed `MCP_AUTH_TOKEN` or any `.env` value by hand, `docker compose up -d` applies it.
Your data lives in Docker volumes (`postgres_data`, `redis_data`, ...) and survives upgrades.

## Backup and restore of the database

All durable data is in PostgreSQL. Dump it with `pg_dump` inside the container (no host tools needed):

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > backups/mandrel-$(date +%Y%m%d-%H%M%S).dump
ls -l backups/
```

The dump is a binary file containing all your records: keep it as private as `.env`.

To restore into the running stack (this **replaces** the current database contents; stop the writers
first):

```bash
docker compose stop mcp-server mandrel-command-backend mandrel-command-frontend
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < backups/mandrel-YYYYMMDD-HHMMSS.dump
docker compose start mcp-server mandrel-command-backend mandrel-command-frontend
./scripts/validate-install.sh
```

Test a backup before you need it: restore it into a scratch stack (a second clone, or after
`docker compose down -v` on a throwaway machine) and run the validator.

## Changing settings

Edit `.env` (or add a `docker-compose.override.yml`, see [Supersession](supersession.md)) and apply
with `docker compose up -d`. All settings are in the
[configuration reference](../reference/configuration.md).

## Uninstalling

Stop the stack and keep your data:

```bash
docker compose down
```

Remove the stack **and delete all stored data** (the database volume too):

```bash
docker compose down -v
```

Then remove the images if you want the disk space back (`docker image ls 'mandrel/*'`,
`docker rmi ...`), and delete the clone directory. Remove the agent's connection with
`claude mcp remove mandrel`.
