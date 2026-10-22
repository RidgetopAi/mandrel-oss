-- Postgres extensions required by Mandrel.
-- Mounted into the postgres container at /docker-entrypoint-initdb.d/ so it runs
-- automatically on FIRST init of a fresh data volume (ankane/pgvector image).
-- Idempotent: safe to re-run.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
