/**
 * buildTaskEmbeddingText — UNIT contract.
 *
 * Pure, no DB, no embedder. This file pins the SHAPE of the string that will be baked into
 * every task vector in the fleet, and the two properties that shape has to have:
 *   1. it is BOUNDED to EMBEDDING_MAX_TEXT_LENGTH (the embedder throws above it);
 *   2. it does NOT contain the task's STATUS (status is spent in the ranking importance map;
 *      having it in both places double-counts it).
 *
 * Property 2 is asserted rather than described because it is the kind of thing a later,
 * reasonable-looking edit adds back ("the embed text should include status, obviously").
 */
import { describe, test, expect } from 'vitest';
import { buildTaskEmbeddingText, buildTaskEmbeddingTextFromRow } from '../services/embedding/taskEmbeddingText.js';
import { EMBEDDING_MAX_TEXT_LENGTH } from '../config/embeddingConfig.js';

describe('buildTaskEmbeddingText', () => {
  test('labelled header lines, then title, then description', () => {
    expect(
      buildTaskEmbeddingText({
        type: 'feature',
        priority: 'high',
        tags: ['ref:recall', 'scope:search'],
        title: 'Give tasks an embedding column',
        description: 'smart_search has listed the task source since commit 1.',
      }),
    ).toBe(
      'Type: feature\n' +
        'Priority: high\n' +
        'Tags: ref:recall, scope:search\n' +
        'Give tasks an embedding column\n' +
        'smart_search has listed the task source since commit 1.',
    );
  });

  test('absent and empty fields are omitted, not rendered as blanks or "undefined"', () => {
    const text = buildTaskEmbeddingText({ title: 'Only a title' });
    expect(text).toBe('Only a title');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  test('the fully empty task yields the empty string (total, never throws)', () => {
    expect(buildTaskEmbeddingText({})).toBe('');
    expect(buildTaskEmbeddingText({ tags: [], title: '', description: '   ' })).toBe('');
  });

  test('output is BOUNDED to the embedder cap — an unbounded builder makes the row un-embeddable', () => {
    const text = buildTaskEmbeddingText({ title: 'long one', description: 'x'.repeat(50_000) });
    expect(text.length).toBe(EMBEDDING_MAX_TEXT_LENGTH);
  });

  test('STATUS IS NOT IN THE EMBED TEXT (it is spent in the ranking importance term)', () => {
    // The builder has no status parameter at all, so the only way status could leak in is
    // through another field. Passing it as an extra key must change nothing.
    const withoutStatus = buildTaskEmbeddingText({ title: 'Ship the thing', type: 'feature' });
    const withStatusKey = buildTaskEmbeddingText({
      title: 'Ship the thing',
      type: 'feature',
      // @ts-expect-error — deliberately passing a field the contract does not accept
      status: 'completed',
    });
    expect(withStatusKey).toBe(withoutStatus);
    expect(withoutStatus).not.toContain('completed');
    expect(withoutStatus).not.toContain('Status');
  });

  test('the row adapter maps exactly the five embed columns', () => {
    const row = {
      type: 'bugfix',
      priority: 'urgent',
      tags: ['t'],
      title: 'ti',
      description: 'de',
      // fields that exist on the row and must NOT reach the text:
      status: 'completed',
      assigned_to: 'builder',
      metadata: { secret: 'x' },
    } as any;
    const text = buildTaskEmbeddingTextFromRow(row);
    expect(text).toBe(buildTaskEmbeddingText({ type: 'bugfix', priority: 'urgent', tags: ['t'], title: 'ti', description: 'de' }));
    expect(text).not.toContain('completed');
    expect(text).not.toContain('builder');
    expect(text).not.toContain('secret');
  });
});
