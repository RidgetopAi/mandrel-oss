/**
 * ID-PARAM SYNONYM NORMALIZATION — MCP-2026 rebuild Phase 1.
 *
 * The rebuild unifies every record-handle param onto `id` (and the bulk list onto `ids`)
 * via `$defs.Ref`. Phase 1 must ACCEPT the new `id`/`ids` names WITHOUT breaking the legacy
 * `contextId`/`decisionId`/`taskId`/`task_ids` names — every live caller + the CLAUDE.md
 * boot ritual still uses the legacy names, and the byte-identical tools/list gate means the
 * legacy names stay the advertised/declared canonical in Phase 1.
 *
 * This test proves BOTH directions of the guarantee through the real validation seam
 * (validateToolArguments): (1) legacy names still validate and reach the handler on their
 * canonical field, and (2) the new unified names are accepted and normalized onto that same
 * canonical field.
 */

import { describe, test, expect } from 'vitest';
import { validateToolArguments } from '../middleware/validation.js';

const SHORT_ID = 'abcdef12'; // 8-hex short id — accepted by uuidOrShortId()
const FULL_UUID = '00000000-0000-0000-0000-000000000001';

describe('id-param synonyms — legacy names STILL accepted (no live caller breaks)', () => {
  test('context_delete accepts legacy contextId', () => {
    const out: any = validateToolArguments('context_delete', { contextId: SHORT_ID });
    expect(out.contextId).toBe(SHORT_ID);
  });

  test('decision_get accepts legacy decisionId', () => {
    const out: any = validateToolArguments('decision_get', { decisionId: FULL_UUID });
    expect(out.decisionId).toBe(FULL_UUID);
  });

  test('task_details accepts legacy taskId', () => {
    const out: any = validateToolArguments('task_details', { taskId: SHORT_ID });
    expect(out.taskId).toBe(SHORT_ID);
  });

  test('task_bulk_update accepts legacy task_ids', () => {
    const out: any = validateToolArguments('task_bulk_update', { task_ids: [SHORT_ID], status: 'completed' });
    expect(out.task_ids).toEqual([SHORT_ID]);
  });
});

describe('id-param synonyms — new unified id/ids names now accepted, mapped to canonical', () => {
  test('context_delete accepts id → normalized to contextId', () => {
    const out: any = validateToolArguments('context_delete', { id: SHORT_ID });
    expect(out.contextId).toBe(SHORT_ID);
    expect(out.id).toBeUndefined();
  });

  test('context_update accepts id → contextId (with an edit field)', () => {
    const out: any = validateToolArguments('context_update', { id: SHORT_ID, tags: ['x'] });
    expect(out.contextId).toBe(SHORT_ID);
    expect(out.id).toBeUndefined();
  });

  test('decision_get accepts id → normalized to decisionId', () => {
    const out: any = validateToolArguments('decision_get', { id: FULL_UUID });
    expect(out.decisionId).toBe(FULL_UUID);
    expect(out.id).toBeUndefined();
  });

  test('task_details accepts id → normalized to taskId', () => {
    const out: any = validateToolArguments('task_details', { id: SHORT_ID });
    expect(out.taskId).toBe(SHORT_ID);
    expect(out.id).toBeUndefined();
  });

  test('task_bulk_update accepts ids → normalized to task_ids', () => {
    const out: any = validateToolArguments('task_bulk_update', { ids: [SHORT_ID], status: 'completed' });
    expect(out.task_ids).toEqual([SHORT_ID]);
    expect(out.ids).toBeUndefined();
  });
});

describe('id-param synonyms — precedence + non-interference', () => {
  test('legacy is never clobbered by the alias — supplying BOTH surfaces the ambiguity', () => {
    // The shim only normalizes the alias when the legacy name is ABSENT (it never silently
    // overrides an explicit legacy id). So passing BOTH leaves the extra `id` in place, and
    // strict-key rejects it with an actionable error rather than guessing which one to honor.
    expect(() => validateToolArguments('task_details', { taskId: SHORT_ID, id: 'ffffffff' })).toThrow();
  });

  test('id-native ops (context_search) are UNTOUCHED — a legacy alias stays an unknown key', () => {
    // context_search declares `id` natively; the shim only fires on legacy-declaring ops, so
    // passing `contextId` here is still rejected as an undeclared param (no broadening).
    expect(() => validateToolArguments('context_search', { contextId: SHORT_ID })).toThrow();
  });
});
