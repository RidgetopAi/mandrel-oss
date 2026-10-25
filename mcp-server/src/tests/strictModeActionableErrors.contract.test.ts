/**
 * STRICT-MODE + ACTIONABLE-ERROR Contract Guard  (folds in an earlier change)
 *
 * Two best-MCP invariants this locks shut:
 *
 *  A. STRICT TOOL CONTRACTS — every tool's model-facing `inputSchema` declares
 *     `additionalProperties:false`, so the model is handed an EXACT param contract
 *     (derived at the source from the zod validator, table-driven). And the VALIDATOR
 *     now rejects an undeclared param (zod's .parse() used to silently STRIP unknowns,
 *     letting the advertised contract drift from the accepted one). advertised==accepted.
 *
 *  B. ACTIONABLE, SELF-CORRECTING, SECURE ERRORS — every validation failure tells the
 *     model WHAT is wrong (field + problem), WHAT to try (allowed values / expected
 *     type), and gives an EXAMPLE corrected call, produced at ONE central seam from the
 *     structured zod issue (not 30 bespoke strings). Handler errors are SANITIZED so no
 *     SQL / stack / secret / internal path can leak. A not-found is actionable.
 *
 * These are deterministic guards (mostly pure validation; one DB-backed not-found).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { validateToolArguments } from '../middleware/validation.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { formatMcpError } from '../utils/mcpFormatter.js';
import { sanitizeErrorText } from '../utils/actionableError.js';

const STAMP = Date.now();

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

// ── PART A: STRICT MODE ──────────────────────────────────────────────────────
describe('PART A: strict-mode tool contracts', () => {
  test('A1: EVERY tool inputSchema declares additionalProperties:false', () => {
    const offenders = AIDIS_TOOL_DEFINITIONS.filter(
      (d) => d.inputSchema.additionalProperties !== false,
    ).map((d) => d.name);
    expect(offenders, `tools without strict additionalProperties:false: ${offenders.join(', ')}`).toEqual([]);
    // sanity: we actually checked the whole fleet, not an empty list
    expect(AIDIS_TOOL_DEFINITIONS.length).toBeGreaterThanOrEqual(27);
  });

  test('A2: a BOGUS undeclared param is REJECTED by the validator', () => {
    expect(() => validateToolArguments('task_list', { bogusParam: 'x', limit: 5 }))
      .toThrow(/Unknown parameter\(s\)/i);
    // the rejection names the offending key (actionable)
    expect(() => validateToolArguments('task_list', { totallyMadeUp: 1 }))
      .toThrow(/totallyMadeUp/);
  });

  test('A3: strict mode does NOT break legit declared params (incl. coerced-string booleans)', () => {
    // coerced-string boolean (the task-2 class) must still pass under strict mode
    const v = validateToolArguments('decision_search', { includeOutcome: 'true' }) as any;
    expect(v.includeOutcome).toBe(true);
    // a fully-declared call goes through untouched
    expect(() => validateToolArguments('task_list', { status: 'todo', priority: 'high', limit: 5 }))
      .not.toThrow();
  });

  test('A4: AI-friendly decision synonyms are still ACCEPTED under strict mode', () => {
    // reasoning→rationale, impact→impactLevel are normalized BEFORE the strict-key
    // check, so strict mode must not reject them.
    const v = validateToolArguments('decision_record', {
      decisionType: 'architecture',
      title: 't',
      description: 'd',
      reasoning: 'because',
      impact: 'high',
    }) as any;
    expect(v.rationale).toBe('because');
    expect(v.impactLevel).toBe('high');
  });
});

// ── PART B: ACTIONABLE ERRORS ────────────────────────────────────────────────
describe('PART B: actionable, self-correcting, secure errors', () => {
  test('B1: a bad ENUM names the field + allowed values + a corrected EXAMPLE', () => {
    let msg = '';
    try {
      validateToolArguments('task_create', { title: 't', type: 'banana' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Validation failed for task_create/);
    expect(msg).toContain("'type'"); // WHAT field
    expect(msg).toMatch(/Allowed values:/i); // WHAT to try
    expect(msg).toContain('"feature"'); // an actual allowed value listed
    expect(msg).toMatch(/Example: task_create\(/); // EXAMPLE corrected call
  });

  test('B2: a MISSING required field is actionable (field + required + example)', () => {
    let msg = '';
    try {
      validateToolArguments('context_store', {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Validation failed for context_store/);
    expect(msg).toContain("'content'");
    expect(msg).toMatch(/required/i);
    expect(msg).toMatch(/Example: context_store\(/);
  });

  test('B3: a WRONG-TYPE field is actionable (field + expected type + example)', () => {
    let msg = '';
    try {
      validateToolArguments('decision_search', { includeOutcome: 'maybe' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("'includeOutcome'");
    expect(msg).toMatch(/must be a boolean/i);
    expect(msg).toMatch(/Example:/);
  });

  test('B4: a bad UUID hints HOW to find the right id (search → copy full id)', () => {
    let msg = '';
    try {
      validateToolArguments('decision_get', { decisionId: 'abc123' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("'decisionId'");
    expect(msg).toMatch(/full UUID/i);
    expect(msg).toMatch(/search/i); // how to find it
  });

  test('B5: SECURITY — sanitizeErrorText strips SQL/secrets/connection-strings/paths', () => {
    const leaky =
      'duplicate key value violates unique constraint "tasks_pkey"\n' +
      '    at Parser.parseErrorMessage (/home/user/app/node_modules/pg/lib/parser.js:1)\n' +
      'connection postgres://mandrel:s3cr3t@127.0.0.1:5432/mandrel failed; password=hunter2';
    const safe = sanitizeErrorText(leaky);
    expect(safe).not.toMatch(/s3cr3t/);
    expect(safe).not.toMatch(/hunter2/);
    expect(safe).not.toMatch(/postgres:\/\/[^\s]*@/);
    expect(safe).not.toMatch(/\/home\/mandrel\//); // no internal absolute path
    expect(safe).not.toMatch(/\n\s*at\s+/); // no stack frames
  });

  test('B8: an UNKNOWN-parameter error names the tool\'s REQUIRED params inline (Change B)', () => {
    // The strict-key check fires BEFORE schema.parse, so a bogus key throws the unrecognized_keys
    // error directly — which must now list the params that ARE required (mirroring how the enum
    // error lists allowed values), so a wrong guess self-heals in one retry, no discover round-trip.
    let msg = '';
    try {
      validateToolArguments('decision_record', { bogusKey: 1 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Unknown parameter\(s\)/i);
    expect(msg).toContain("'bogusKey'"); // still names the BAD param
    expect(msg).toMatch(/Required param\(s\)/i); // …AND now the required ones
    for (const p of ['decisionType', 'title', 'description', 'rationale', 'impactLevel']) {
      expect(msg, `required param '${p}' should be listed inline`).toContain(`'${p}'`);
    }
  });

  test('B9: the required-param list is derived per-tool (context_store lists content + type)', () => {
    let msg = '';
    try {
      validateToolArguments('context_store', { nonsense: true });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Unknown parameter\(s\)/i);
    expect(msg).toMatch(/Required param\(s\)/i);
    expect(msg).toContain("'content'");
    expect(msg).toContain("'type'");
    // a purely-optional param must NOT be advertised as required
    expect(msg).not.toContain("'tags'");
  });

  test('B10: a tool with NO required params emits no misleading "Required param(s)" clause', () => {
    // task_list has only optional params → the unrecognized_keys error must not fabricate a
    // required list (honest: the clause is omitted when requiredKeys is empty).
    let msg = '';
    try {
      validateToolArguments('task_list', { bogusKey: 1 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Unknown parameter\(s\)/i);
    expect(msg).not.toMatch(/Required param\(s\)/i);
  });

  test('B6: formatMcpError passes an already-actionable validator message through intact', () => {
    const resp = formatMcpError(
      new Error("Validation failed for task_create: 'type' got an invalid value. Allowed values: \"feature\""),
      'task_create',
    );
    expect(resp.isError).toBe(true);
    expect(textOf(resp)).toMatch(/Allowed values/);
  });
});

// ── PART B (DB-backed): not-found is actionable + leaks nothing ───────────────
describe('PART B: not-found error is actionable + secure (DB-backed)', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'strict+actionable guard') RETURNING id`,
        [`strict-actionable-${STAMP}`],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (projectId) {
      await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [projectId]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
  });

  test('B7: decision_get on an unknown (valid-shaped) id is actionable and leaks nothing', async () => {
    const resp = await viaPublicTool(
      'decision_get',
      { decisionId: '00000000-0000-0000-0000-000000000000', projectId },
      (a) => decisionsRoutes.handleGet(a),
    );
    const text = textOf(resp);
    expect(text).toMatch(/not found/i); // WHAT
    expect(text).toMatch(/short id|full UUID/i); // WHAT to try
    expect(text).toMatch(/decision_search/); // HOW to find the right id
    // SECURE: no SQL / stack / connection string / internal path
    expect(text).not.toMatch(/select |insert |update .* set /i);
    expect(text).not.toMatch(/\n\s*at\s+/);
    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).not.toMatch(/\/home\//);
  });
});
