/**
 * `note` IS A FIRST-CLASS CONTEXT TYPE IN THE UI.
 *
 * The server gained a generic capture type, `note` (mcp-server/src/config/contextTypes.ts,
 * migration 100). A type the backend stores but the UI cannot filter by is a type a reader
 * cannot find, so this pins the two UI surfaces a context_type has:
 *   1. the FilterBar renders a `note` facet, with its LIVE count from stats.by_type, and
 *      clicking it filters by exactly 'note';
 *   2. a note row renders its kind badge reading `note`, from an EXPLICIT tone/dot mapping
 *      (not the unknown-kind fallback — the fallback would also be neutral, so the mapping
 *      is asserted by key, which is the assertion the fallback cannot satisfy).
 * Real DOM via react-dom/client under jsdom, same harness as ContextDetail.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FilterBar } from './FilterBar';
import { ContextList } from './ContextList';
import { KIND_TONE, KIND_DOT_VAR, TYPE_FACETS } from './config';
import { KIND_DOT_VAR as GRAPH_KIND_DOT_VAR } from '../../config/graphEdges';
import { KIND_DOT_VAR as TASKS_KIND_DOT_VAR } from '../tasks/config';
import type { Context } from '../../types/context';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('note context type — filter facet', () => {
  it('is a declared facet', () => {
    expect(TYPE_FACETS.map((f) => f.value)).toContain('note');
  });

  it('renders the `note` chip with its live count and filters by note on click', () => {
    const onTypeChange = vi.fn();
    act(() => {
      root.render(
        <FilterBar
          search=""
          onSearchChange={() => {}}
          type={null}
          onTypeChange={onTypeChange}
          sort="newest"
          onSortChange={() => {}}
          stats={{ total_contexts: 7, by_type: { note: 3, handoff: 4 } }}
        />,
      );
    });
    const facets = container.querySelector('[aria-label="Filter by type"]')!;
    const chip = Array.from(facets.querySelectorAll('button')).find((b) => b.textContent?.startsWith('note'));
    expect(chip, 'a facet button labelled note').toBeTruthy();
    expect(chip!.textContent).toBe('note3');
    act(() => chip!.click());
    expect(onTypeChange).toHaveBeenCalledWith('note');
  });
});

describe('note context type — kind badge', () => {
  it('has an explicit tone and dot mapping everywhere a kind is painted (not the fallback)', () => {
    expect(Object.keys(KIND_TONE)).toContain('note');
    expect(Object.keys(KIND_DOT_VAR)).toContain('note');
    expect(Object.keys(GRAPH_KIND_DOT_VAR)).toContain('note');
    expect(Object.keys(TASKS_KIND_DOT_VAR)).toContain('note');
  });

  it('renders a note row with a badge reading `note`', () => {
    const ctx = {
      id: '11111111-2222-4333-8444-555555555555',
      content: 'A generic captured observation.',
      context_type: 'note',
      type: 'note',
      tags: [],
      created_at: new Date().toISOString(),
    } as unknown as Context;
    act(() => {
      root.render(
        <ContextList
          contexts={[ctx]}
          selectedId={null}
          onSelect={() => {}}
          isLoading={false}
          isError={false}
          error={null}
        />,
      );
    });
    const badges = Array.from(container.querySelectorAll('span')).filter((s) => s.textContent === 'note');
    expect(badges.length, 'a kind badge reading note').toBeGreaterThan(0);
  });
});
