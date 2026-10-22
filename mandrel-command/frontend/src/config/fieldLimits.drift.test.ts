/**
 * fieldLimits.drift — pins `config/fieldLimits.ts` (this client's mirror) to the Command
 * BACKEND's column-derived declaration, `mandrel-command/backend/src/config/fieldLimits.ts`,
 * read off disk (Phase 2 item 2).
 *
 * THE CHAIN THIS COMPLETES, and why it bottoms out at the column rather than at an opinion:
 *   browser cap  ──(this guard)──▶  backend cap  ──(backend assignedToFieldLimit.db.test)──▶
 *   the LIVE information_schema of the migrated database
 *   MCP cap      ──(mcp-server tests/fieldLimits.schema.test)──────────────────────────────▶ (same)
 * Three layers, and NONE of them holds a number that another layer has to be trusted for.
 * ALTER the column and the DB tests name it; edit one layer's literal and this names it.
 *
 * WHY A GUARD AND NOT AN IMPORT: stated in full at the top of `config/fieldLimits.ts` —
 * the frontend Docker build context does not contain `backend/src`, so an import compiles
 * locally and breaks the image.
 *
 * THE POPULATION, AND WHY IT IS THE WHOLE ONE (C3): every `varcharColumn(...)` declaration
 * in the backend's fieldLimits module, and every entry of this module's
 * `COLUMN_BACKED_LIMITS`, compared as SETS in BOTH directions on (table, column, length).
 * A cap changed over there is RED; a cap invented here is RED; a column declared there and
 * missing here is RED.
 *
 * INSTRUMENT BY PROPERTY KIND: the backend's declarations are flat literal call sites —
 * a BYTES-shaped property — so a byte-level parse is the right instrument, made honest by
 * a NON-EMPTY TRAP (a parse that finds nothing FAILS rather than passing with an empty
 * set) and by comparing in both directions. The THIRD STATE is explicit: if the backend
 * file cannot be found, this THROWS rather than reporting "no drift".
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { COLUMN_BACKED_LIMITS, TASKS_ASSIGNED_TO } from './fieldLimits';
import { CreateTaskSchema, UpdateTaskSchema } from '../validation/schemas';

const BACKEND_RELPATH = join('mandrel-command', 'backend', 'src', 'config', 'fieldLimits.ts');

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk UP until the ancestor containing the backend declaration (worktree/CI-safe, C4). */
function findRepoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, BACKEND_RELPATH))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${BACKEND_RELPATH} in any ancestor of ${HERE}. This guard derives its ` +
      'expected caps from that file; refusing to pass vacuously.'
  );
}

/** `varcharColumn('tasks', 'assigned_to', 200, …)` → {table, column, length}. */
function parseBackendVarcharColumns(): Array<{ table: string; column: string; length: number }> {
  const source = readFileSync(join(findRepoRoot(), BACKEND_RELPATH), 'utf8');
  if (!source.includes('function varcharColumn')) {
    throw new Error(
      `${BACKEND_RELPATH} no longer declares \`varcharColumn\`. The mirror in ` +
        'src/config/fieldLimits.ts has lost its source of truth — re-point this guard ' +
        'rather than deleting it.'
    );
  }
  const out: Array<{ table: string; column: string; length: number }> = [];
  // Only CALL sites, not the function declaration: a call is followed by a quoted table.
  const re = /varcharColumn\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ table: m[1], column: m[2], length: Number(m[3]) });
  }
  return out;
}

const backendColumns = parseBackendVarcharColumns();
const key = (c: { table: string; column: string; length: number }) =>
  `${c.table}.${c.column}=${c.length}`;

describe('frontend fieldLimits mirrors the backend column-derived caps', () => {
  it('parsed a non-empty set of declarations from the backend file', () => {
    // THE NON-EMPTY TRAP. Without it, a refactor upstream empties the parse and every set
    // comparison below passes while comparing nothing.
    expect(backendColumns.length).toBeGreaterThan(0);
    expect(COLUMN_BACKED_LIMITS.length).toBeGreaterThan(0);
  });

  it('declares exactly the same (table, column, length) set, in BOTH directions', () => {
    expect(backendColumns.map(key).sort()).toEqual(COLUMN_BACKED_LIMITS.map(key).sort());
  });

  it('derives max from length — there is no second number to get wrong', () => {
    for (const limit of COLUMN_BACKED_LIMITS) {
      expect(limit.max).toBe(limit.length);
      expect(limit.why.trim().length).toBeGreaterThan(0);
    }
  });

  // ── The cap is only fixed if the SCHEMAS actually read it. A config nobody consumes is
  // not a fix, and this is the assertion that would have caught the Phase-1 leftover.
  it('the task schemas accept the full column length and reject one character more', () => {
    const atCap = 'a'.repeat(TASKS_ASSIGNED_TO.max);
    const overCap = 'a'.repeat(TASKS_ASSIGNED_TO.max + 1);

    const create = (assigned_to: string) =>
      CreateTaskSchema.safeParse({
        title: 'cap probe',
        priority: 'medium',
        project_id: '00000000-0000-4000-8000-000000000000',
        assigned_to,
      });
    expect(create(atCap).success).toBe(true);
    expect(create(overCap).success).toBe(false);

    expect(UpdateTaskSchema.safeParse({ assigned_to: atCap }).success).toBe(true);
    expect(UpdateTaskSchema.safeParse({ assigned_to: overCap }).success).toBe(false);
  });

  it('accepts the 101..200 range the old literal-100 cap wrongly rejected', () => {
    // The actual user-visible defect: a value MCP accepted and Postgres stored, that this
    // client refused to let anyone save or edit.
    const wasRejected = 'a'.repeat(150);
    expect(wasRejected.length).toBeGreaterThan(100);
    expect(wasRejected.length).toBeLessThanOrEqual(TASKS_ASSIGNED_TO.max);
    expect(UpdateTaskSchema.safeParse({ assigned_to: wasRejected }).success).toBe(true);
  });
});
