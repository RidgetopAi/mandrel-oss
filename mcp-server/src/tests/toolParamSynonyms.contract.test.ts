/**
 * TOOL-SCOPED PARAM SYNONYMS — MCP-2026 rebuild Phase 3.
 *
 * The Phase-3 gateway canary showed the blind model reaching for the INTUITIVE param name:
 *   - project.switch is given `name`  (the tool declares `project`)
 *   - decision.record is given `type` (the tool declares `decisionType`)
 * Both were strict-key-rejected ("Unknown parameter"). This test proves — through the REAL
 * validation seam (validateToolArguments) — that the intuitive name is now accepted as an
 * ADDITIVE, per-opId alias, AND that the alias never bleeds onto a sibling op that has a
 * real param of that name (project_create.name, context_store.type, task_create.type).
 *
 * Surface coverage: because the gateway dispatcher (routes/gateway.ts) strips `action` and
 * delegates to validateToolArguments(opId, …), the SAME per-opId alias covers both the flat
 * call and the gateway branch. The gateway-path tests reproduce that dispatch exactly
 * (resolve → strip action → validate), the validation step the real dispatcher runs.
 */

import { describe, test, expect } from 'vitest';
import { validateToolArguments } from '../middleware/validation.js';
import { resolveGatewayAction } from '../config/gatewayResolver.js';

// A complete, otherwise-valid decision_record payload (minus the type/decisionType field,
// which each test supplies) so a positive case actually .parse()es to the end.
const decisionBase = {
  title: 'Ship gateway param synonyms',
  description: 'Accept intuitive param names on the gateway surface.',
  rationale: 'The blind model reaches for name/type; map them to the canonical param.',
  impactLevel: 'low' as const,
};

/**
 * Mirror the gateway dispatcher's validation step (routes/gateway.ts dispatchGateway):
 * resolve (gateway, action) → opId, strip the `action` discriminator, then run the SAME
 * per-op validator. Returns the validated args (throws exactly as the real path would).
 */
function validateViaGateway(gateway: string, action: string, rest: Record<string, any>) {
  const resolution = resolveGatewayAction(gateway, action);
  if (!resolution) throw new Error(`gateway resolution failed for ${gateway}.${action}`);
  const branchArgs: Record<string, any> = { action, ...rest };
  delete branchArgs.action; // dispatcher strips the discriminator before validating
  return validateToolArguments(resolution.opId, branchArgs) as any;
}

describe('tool-scoped param synonyms — FLAT surface: intuitive name accepted', () => {
  test('(a) project_switch { name: X } resolves to project=X and validates', () => {
    const out: any = validateToolArguments('project_switch', { name: 'riverbend' });
    expect(out.project).toBe('riverbend');
    expect(out.name).toBeUndefined();
  });

  test('(b) decision_record { type: "deployment", … } resolves to decisionType and validates', () => {
    const out: any = validateToolArguments('decision_record', { ...decisionBase, type: 'deployment' });
    expect(out.decisionType).toBe('deployment');
    expect(out.type).toBeUndefined();
    // full payload still validates end-to-end (all required fields present)
    expect(out.title).toBe(decisionBase.title);
    expect(out.impactLevel).toBe('low');
  });
});

describe('tool-scoped param synonyms — GATEWAY surface: one fix covers both', () => {
  test('(d) project { action:"switch", name: X } → project=X via the gateway path', () => {
    const out = validateViaGateway('project', 'switch', { name: 'riverbend' });
    expect(out.project).toBe('riverbend');
    expect(out.name).toBeUndefined();
  });

  test('(d) decision { action:"record", type: "deployment", … } → decisionType via the gateway path', () => {
    const out = validateViaGateway('decision', 'record', { ...decisionBase, type: 'deployment' });
    expect(out.decisionType).toBe('deployment');
    expect(out.type).toBeUndefined();
  });
});

describe('tool-scoped param synonyms — NEGATIVE guards: no bleed onto sibling ops', () => {
  test('(c) project_create { name: X } keeps `name` as the real project name (NOT remapped)', () => {
    const out: any = validateToolArguments('project_create', { name: 'brand-new-project' });
    expect(out.name).toBe('brand-new-project');
    expect(out.project).toBeUndefined();
  });

  test('(c) context_store { type: "code", … } keeps `type` unchanged (real param, not remapped)', () => {
    const out: any = validateToolArguments('context_store', { content: 'hello world', type: 'code' });
    expect(out.type).toBe('code');
    expect(out.decisionType).toBeUndefined();
  });

  test('(c) task_create { type: … } keeps `type` unchanged (real param, not remapped)', () => {
    const out: any = validateToolArguments('task_create', { title: 'a task', type: 'feature' });
    expect(out.type).toBe('feature');
    expect(out.decisionType).toBeUndefined();
  });

  test('(c) project_create is untouched via the gateway path too', () => {
    const out = validateViaGateway('project', 'create', { name: 'brand-new-project' });
    expect(out.name).toBe('brand-new-project');
    expect(out.project).toBeUndefined();
  });
});

describe('tool-scoped param synonyms — precedence + non-interference', () => {
  test('canonical is never clobbered — supplying BOTH surfaces the ambiguity (strict-key rejects)', () => {
    // The shim only maps the synonym when the canonical is ABSENT. Supplying both leaves the
    // extra `name` in place → strict-key rejects it rather than guessing which to honor.
    expect(() => validateToolArguments('project_switch', { project: 'a', name: 'b' })).toThrow();
  });

  test('an unrelated op with neither synonym nor a table entry is unaffected', () => {
    // task_create with only its real fields validates; nothing about the synonym seam fires.
    const out: any = validateToolArguments('task_create', { title: 'plain task' });
    expect(out.title).toBe('plain task');
  });
});
