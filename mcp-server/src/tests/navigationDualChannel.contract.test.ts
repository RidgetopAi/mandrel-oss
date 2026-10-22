/**
 * Navigation Dual-Channel Contract Test
 *
 * THE BUG THIS LOCKS SHUT:
 *   `mandrel_explain` and `mandrel_examples` (and `mandrel_help`) declared the empty
 *   `statusShape` outputSchema and emitted a bodiless `{ ok: true }` structuredContent —
 *   the real help/params/examples lived ONLY in the human `content` text. A dual-channel
 *   MCP client (Claude Code) surfaces `structuredContent` and drops `content`, so the
 *   caller saw `{ ok:true }` with NO body. The fix: the real help now rides the MACHINE
 *   channel too, as RAW values, documented by a proper outputSchema.
 *
 * Driven through the SAME public path the HTTP bridge uses (validate → routeExecutor),
 * so the dual-channel SEAM (ensureStructuredContent) is exercised — exactly what the
 * client receives. Validation against the advertised outputSchema uses ajv.
 *
 * These assertions FAIL before the fix (structuredContent was `{ok:true}` only) and
 * PASS after (structuredContent carries tool/description/parameters/examples).
 */

import { describe, test, expect } from 'vitest';
import Ajv from 'ajv';

import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const ajv = new Ajv({ allErrors: true, strict: false });

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

function outputSchemaFor(toolName: string): any {
  const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === toolName);
  expect(def, `tool definition for ${toolName}`).toBeTruthy();
  return def!.outputSchema;
}

function expectValidStructured(toolName: string, resp: any) {
  expect(resp.structuredContent, `${toolName} must return structuredContent`).toBeTruthy();
  const validate = ajv.compile(outputSchemaFor(toolName));
  const ok = validate(resp.structuredContent);
  expect(
    ok,
    `${toolName} structuredContent must validate against its outputSchema. ` +
      `Errors: ${JSON.stringify(validate.errors)} | Got: ${JSON.stringify(resp.structuredContent)}`
  ).toBe(true);
}

describe('navigation dual-channel (mandrel_explain / mandrel_examples / mandrel_help)', () => {
  test('mandrel_explain carries the REAL explanation in structuredContent (not empty {ok})', async () => {
    const resp = await viaPublicTool('mandrel_explain', { toolName: 'decision_record' });

    // The regression: structuredContent used to be ONLY { ok: true }. Now it carries body.
    const sc = resp.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.tool).toBe('decision_record');
    expect(typeof sc.description).toBe('string');
    expect(sc.description.length).toBeGreaterThan(0);
    expect(sc.category).toBe('Technical Decisions');
    expect(Array.isArray(sc.parameters)).toBe(true);
    expect(sc.parameters.length).toBeGreaterThan(0);

    // The known-required params of decision_record must be present + flagged required.
    const byName = new Map(sc.parameters.map((p: any) => [p.name, p]));
    for (const req of ['decisionType', 'title', 'description', 'rationale', 'impactLevel']) {
      expect(byName.has(req), `param ${req} present`).toBe(true);
      expect((byName.get(req) as any).required, `param ${req} required`).toBe(true);
    }

    // Dual-channel: the human text is STILL retained alongside the machine channel.
    expect(textOf(resp)).toContain('decision_record');
    expectValidStructured('mandrel_explain', resp);
  });

  test('mandrel_examples carries the REAL examples in structuredContent (not empty {ok})', async () => {
    const resp = await viaPublicTool('mandrel_examples', { toolName: 'decision_record' });

    const sc = resp.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.tool).toBe('decision_record');
    expect(Array.isArray(sc.examples)).toBe(true);
    expect(sc.examples.length).toBeGreaterThan(0);
    for (const ex of sc.examples) {
      expect(typeof ex.title).toBe('string');
      expect(ex.title.length).toBeGreaterThan(0);
      expect(typeof ex.example).toBe('string');
      expect(ex.example.length).toBeGreaterThan(0);
    }
    // A curated example for decision_record includes a real call snippet.
    expect(sc.examples.some((e: any) => e.example.includes('decision_record('))).toBe(true);

    expect(textOf(resp)).toContain('decision_record');
    expectValidStructured('mandrel_examples', resp);
  });

  test('mandrel_help carries the full catalog in structuredContent', async () => {
    const resp = await viaPublicTool('mandrel_help', {});
    const sc = resp.structuredContent;
    expect(sc.ok).toBe(true);
    expect(sc.totalTools).toBeGreaterThan(0);
    expect(sc.totalCategories).toBeGreaterThan(0);
    expect(Array.isArray(sc.categories)).toBe(true);
    // The catalog's tool count must equal the advertised totalTools (no drift).
    const flat = sc.categories.flatMap((c: any) => c.tools);
    expect(flat.length).toBe(sc.totalTools);
    expect(flat.some((t: any) => t.name === 'decision_record')).toBe(true);
    expectValidStructured('mandrel_help', resp);
  });

  test('not-found path still validates (REQUIRED-SET rule: only ok is guaranteed)', async () => {
    const resp = await viaPublicTool('mandrel_explain', { toolName: 'no_such_tool_xyz' });
    // No descriptive fields on the not-found path — schema must still accept it.
    expect(resp.structuredContent.ok).toBe(true);
    expect(textOf(resp).toLowerCase()).toContain('not found');
    expectValidStructured('mandrel_explain', resp);

    const resp2 = await viaPublicTool('mandrel_examples', { toolName: 'no_such_tool_xyz' });
    expect(textOf(resp2).toLowerCase()).toContain('not found');
    expectValidStructured('mandrel_examples', resp2);
  });
});
