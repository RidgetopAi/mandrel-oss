/**
 * Migration 106 — the Surveyor tables are DROPPED (layer 3).
 *
 * After migrate.ts has run against a database, no table, view or materialized view whose name
 * starts with `surveyor_` / `v_surveyor` may exist. 000 and 053 still CREATE them (applied
 * history, never edited); 106 is what removes them, so this fails if 106 is missing or
 * incomplete. The second test applies the exact 106 SQL over a re-created Surveyor shape and
 * proves it drops everything, children first, and is safe to run twice.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db } from '../config/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_SQL = readFileSync(
  resolve(__dirname, '../../database/migrations/106_drop_surveyor_tables.sql'),
  'utf8',
);

const SURVEYOR_RELATIONS_SQL = `
  SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (c.relname LIKE 'surveyor\\_%' OR c.relname LIKE 'v\\_surveyor%')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY c.relname`;

describe('migration 106 — Surveyor tables dropped', () => {
  test('a migrated database has no surveyor_* table or v_surveyor* view', async () => {
    const { rows } = await db.query(SURVEYOR_RELATIONS_SQL);
    expect(rows).toEqual([]);
  });

  test('the 106 SQL drops a full Surveyor shape (view + FK children) and is idempotent', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TABLE surveyor_scans (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
        CREATE TABLE surveyor_nodes (id uuid PRIMARY KEY, scan_id uuid REFERENCES surveyor_scans(id));
        CREATE TABLE surveyor_connections (id uuid PRIMARY KEY, scan_id uuid REFERENCES surveyor_scans(id));
        CREATE TABLE surveyor_warnings (id uuid PRIMARY KEY, scan_id uuid REFERENCES surveyor_scans(id));
        CREATE TABLE surveyor_function_summaries (id uuid PRIMARY KEY, scan_id uuid REFERENCES surveyor_scans(id));
        CREATE VIEW v_surveyor_scan_summaries AS SELECT id FROM surveyor_scans`);
      expect((await client.query(SURVEYOR_RELATIONS_SQL)).rows).toHaveLength(6);

      await client.query(MIG_SQL);
      expect((await client.query(SURVEYOR_RELATIONS_SQL)).rows).toEqual([]);

      await client.query(MIG_SQL); // second run: IF EXISTS makes it a no-op
      expect((await client.query(SURVEYOR_RELATIONS_SQL)).rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
