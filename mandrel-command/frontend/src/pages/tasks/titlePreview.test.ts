/**
 * THE TASKS TITLE PREVIEW IS DERIVED FROM THE COLUMN, AND THE CARD GEOMETRY IS WHY
 * (batch 6 / lane M-10, folded in from an earlier task).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT
 * ════════════════════════════════════════════════════════════════════════════════════
 * `TASKS_CONFIG.titlePreviewChars` was a free `140` — the seventh hand-copied instance of
 * that number in this client. A free number nobody can re-derive is the defect; changing
 * it to a different free number is the same defect one digit over.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY NOT THE CONTEXTS DERIVATION — MEASURED, AND IT INVERTED THE ASSUMPTION
 * ════════════════════════════════════════════════════════════════════════════════════
 * The Contexts rail derives its budget from what its card can DRAW: a fixed
 * `--rail-width` box with `-webkit-line-clamp` over an UNBOUNDED `contexts.content` TEXT
 * column. The obvious move was to copy that method here. It does not apply, and this file
 * asserts each reason rather than stating it:
 *   1. `Tasks.module.css` declares NO `-webkit-line-clamp` at all. `.tcTitle` wraps.
 *      There is no clamp to multiply by, and no character the card refuses to draw.
 *   2. The board column is `repeat(4, 1fr)` — a fraction of the viewport. There is no
 *      fixed px width to divide by, so the (width / glyph) term has no operand.
 * Copying `148` across would have recreated the exact defect in a new place, with a
 * derivation whose inputs do not exist on this page.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHAT DOES GOVERN IT
 * ════════════════════════════════════════════════════════════════════════════════════
 * The slice's surviving job is bounding the DOM payload. `tasks.title` is
 * `character varying(500)` — the data is already bounded — so the column IS the bound.
 * `TASKS_TITLE` is a `varcharColumn`, so `max === length`, and that length is pinned to
 * the live `information_schema` by `backend/__tests__/assignedToFieldLimit.db.test.ts`
 * (which iterates `COLUMN_BACKED_LIMITS`) and mirrored in both directions by
 * `config/fieldLimits.drift.test.ts`. No rung of that chain holds a free number.
 *
 * SCOPE, STATED (C3): this guard's population is the tasks page's three `taskTitle()`
 * render sites and the stylesheet they are drawn by. It makes no claim about other pages,
 * and deliberately none about `mcp-server`'s `RECORD_HEADLINE_CONFIG` — the frontend build
 * context does not contain that package, so any such claim would be unexecutable here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { TASKS_CONFIG } from './config';
import { taskTitle } from './parts';
import { TASKS_TITLE } from '../../config/fieldLimits';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(here, './Tasks.module.css');

/** Read the stylesheet, or FAIL — a file we cannot read is not "no clamp found" (C1). */
function tasksCss(): string {
  const css = readFileSync(CSS_PATH, 'utf8');
  if (css.trim().length === 0) {
    throw new Error(
      'Tasks.module.css is empty. The geometry assertions below derive from it; refusing ' +
        'to pass vacuously.'
    );
  }
  return css;
}

describe('tasks title preview is column-derived (lane M-10)', () => {
  it('is the column cap, with no second number to get wrong', () => {
    expect(TASKS_CONFIG.titlePreviewChars).toBe(TASKS_TITLE.max);
    expect(TASKS_TITLE.max).toBe(TASKS_TITLE.length);
    expect(TASKS_TITLE.table).toBe('tasks');
    expect(TASKS_TITLE.column).toBe('title');
    // Non-empty trap: a zero/NaN cap would make every bound below vacuously satisfiable.
    expect(Number.isFinite(TASKS_CONFIG.titlePreviewChars)).toBe(true);
    expect(TASKS_CONFIG.titlePreviewChars).toBeGreaterThan(0);
  });

  it('THE MEASUREMENT: the tasks stylesheet applies no line clamp at all', () => {
    // The premise of the contexts derivation. If someone ADDS a clamp to this page, this
    // goes RED and the budget must be re-derived from the card, not from the column.
    const css = tasksCss();
    expect(css.match(/line-clamp/g) ?? []).toEqual([]);
  });

  it('...and the board column has no fixed px width to divide by', () => {
    const css = tasksCss();
    const board = css.match(/\.board\s*\{[^}]*\}/s);
    if (!board) {
      throw new Error(
        'Could not find the `.board` rule in Tasks.module.css. The width half of the ' +
          'geometry argument is derived from it; re-point this guard rather than deleting it.'
      );
    }
    expect(board[0]).toContain('grid-template-columns: repeat(4, 1fr)');
    expect(board[0]).not.toContain('rail-width');
  });

  it('...and .tcTitle neither clamps nor ellipsises — the card wraps and draws it all', () => {
    const css = tasksCss();
    const rule = css.match(/\.tcTitle\s*\{[^}]*\}/s);
    if (!rule) {
      throw new Error(
        'Could not find the `.tcTitle` rule in Tasks.module.css. Re-point this guard ' +
          'rather than deleting it.'
      );
    }
    expect(rule[0]).not.toContain('text-overflow');
    expect(rule[0]).not.toContain('overflow');
  });

  it('THE POINT: the slice never cuts a character a render site could have drawn', () => {
    // A title cannot exceed the column, and the widest site draws all of it.
    expect(TASKS_CONFIG.titlePreviewChars).toBeGreaterThanOrEqual(TASKS_TITLE.max);
  });

  it('the clip is actually applied — an over-long title comes back at the budget', () => {
    const long = 'x'.repeat(TASKS_CONFIG.titlePreviewChars * 3);
    expect(taskTitle(long)).toHaveLength(TASKS_CONFIG.titlePreviewChars);
  });

  it('a title at exactly the column length survives intact', () => {
    const atCap = 'y'.repeat(TASKS_TITLE.max);
    expect(taskTitle(atCap)).toBe(atCap);
  });

  it('the empty and absent populations get the placeholder, not an empty title', () => {
    for (const v of ['', null, undefined]) {
      expect(taskTitle(v as string | null | undefined)).toBe('(untitled task)');
    }
  });
});
