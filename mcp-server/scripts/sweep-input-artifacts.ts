#!/usr/bin/env node
/**
 * READ-ONLY existing-data sweep for boundary-hygiene corruption.
 *
 * The 2026-07-17 audit only covered OPEN tasks. This sweeps the WHOLE store — tasks,
 * contexts, AND technical_decisions — for the SAME two corruption signatures the new
 * boundary guard now rejects on write, using the EXACT same centralized detector
 * (utils/inputHygiene — code-span aware, so a legit record that QUOTES tool-call tags in
 * backticks is NOT counted). One detector for the write-guard AND this sweep.
 *
 * IT IS STRICTLY READ-ONLY. It runs only SELECTs and mutates NOTHING — remediation of any
 * rows it flags is a SEPARATE, GATED follow-up (the write guard stops NEW corruption; old
 * rows are a data-cleanup decision for the coordinator/the operator, not this script's job).
 *
 * USAGE (points at whatever DATABASE_* env is set — e.g. the disposable ci_* DB, or prod
 * on the production host):
 *   npx tsx scripts/sweep-input-artifacts.ts            # human summary
 *   npx tsx scripts/sweep-input-artifacts.ts --json     # machine-readable
 *   npx tsx scripts/sweep-input-artifacts.ts --samples  # + up to 5 sample ids per field
 */

import { db } from '../src/config/database.js';
import { findArtifactSignatures, isReservedIdentityString } from '../src/utils/inputHygiene.js';

const JSON_OUT = process.argv.includes('--json');
const SHOW_SAMPLES = process.argv.includes('--samples');
const SAMPLE_CAP = 5;

/** A text field to scan for leaked tool-call XML. */
interface TextField { table: string; idCol: string; col: string; }
/** An identity field to scan for the literal "null"/"undefined". */
interface IdField { table: string; idCol: string; col: string; }

const ARTIFACT_FIELDS: TextField[] = [
  { table: 'tasks', idCol: 'id', col: 'title' },
  { table: 'tasks', idCol: 'id', col: 'description' },
  { table: 'contexts', idCol: 'id', col: 'content' },
  { table: 'technical_decisions', idCol: 'id', col: 'title' },
  { table: 'technical_decisions', idCol: 'id', col: 'description' },
  { table: 'technical_decisions', idCol: 'id', col: 'rationale' },
  { table: 'technical_decisions', idCol: 'id', col: 'problem_statement' },
  { table: 'technical_decisions', idCol: 'id', col: 'success_criteria' },
  { table: 'technical_decisions', idCol: 'id', col: 'outcome_notes' },
  { table: 'technical_decisions', idCol: 'id', col: 'lessons_learned' },
  { table: 'technical_decisions', idCol: 'id', col: 'superseded_reason' },
];

const IDENTITY_FIELDS: IdField[] = [
  { table: 'tasks', idCol: 'id', col: 'assigned_to' },
  { table: 'tasks', idCol: 'id', col: 'created_by' },
];

interface FieldResult {
  table: string;
  col: string;
  kind: 'artifact' | 'identity';
  scanned: number;
  flagged: number;
  samples: { id: string; signatures?: string[] }[];
}

async function sweepArtifactField(f: TextField): Promise<FieldResult> {
  const rows = (await db.query(
    `SELECT ${f.idCol}::text AS id, ${f.col} AS val FROM ${f.table} WHERE ${f.col} IS NOT NULL`
  )).rows;
  const samples: { id: string; signatures?: string[] }[] = [];
  let flagged = 0;
  for (const r of rows) {
    const sigs = findArtifactSignatures(r.val);
    if (sigs.length > 0) {
      flagged++;
      if (samples.length < SAMPLE_CAP) samples.push({ id: r.id, signatures: sigs });
    }
  }
  return { table: f.table, col: f.col, kind: 'artifact', scanned: rows.length, flagged, samples };
}

async function sweepIdentityField(f: IdField): Promise<FieldResult> {
  const rows = (await db.query(
    `SELECT ${f.idCol}::text AS id, ${f.col} AS val FROM ${f.table} WHERE ${f.col} IS NOT NULL`
  )).rows;
  const samples: { id: string }[] = [];
  let flagged = 0;
  for (const r of rows) {
    if (isReservedIdentityString(r.val)) {
      flagged++;
      if (samples.length < SAMPLE_CAP) samples.push({ id: r.id });
    }
  }
  return { table: f.table, col: f.col, kind: 'identity', scanned: rows.length, flagged, samples };
}

async function main() {
  const results: FieldResult[] = [];
  for (const f of ARTIFACT_FIELDS) results.push(await sweepArtifactField(f));
  for (const f of IDENTITY_FIELDS) results.push(await sweepIdentityField(f));

  const totalFlagged = results.reduce((n, r) => n + r.flagged, 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({ totalFlagged, results }, null, 2));
  } else {
    console.log('\n=== INPUT-ARTIFACT SWEEP (READ-ONLY — mutates nothing) ===\n');
    console.log('field                                          scanned   flagged');
    console.log('---------------------------------------------  -------   -------');
    for (const r of results) {
      const label = `${r.table}.${r.col} (${r.kind})`.padEnd(45);
      console.log(`${label}  ${String(r.scanned).padStart(7)}   ${String(r.flagged).padStart(7)}`);
      if (SHOW_SAMPLES && r.samples.length > 0) {
        for (const s of r.samples) {
          const sig = 'signatures' in s && s.signatures ? ` [${s.signatures.join(', ')}]` : '';
          console.log(`      ↳ ${s.id.slice(0, 8)}${sig}`);
        }
      }
    }
    console.log(`\nTOTAL flagged rows-fields: ${totalFlagged}`);
    console.log('NOTE: remediation is a SEPARATE GATED step — this script only reports.\n');
  }

  await db.end();
  // Non-zero exit if anything flagged, so a CI/cron caller can gate on it — but this NEVER
  // mutates, so the exit code is purely informational.
  process.exit(totalFlagged > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('sweep failed:', e);
  process.exit(2);
});
