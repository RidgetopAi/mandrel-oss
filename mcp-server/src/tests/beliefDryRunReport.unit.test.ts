/**
 * belief DRY-RUN REPORT shaping — PURE unit tests (BL-8).
 *
 * The HARD/SOFT tier split these tests used to lock was deleted in an earlier task along with
 * the hard `supersedes` mint, so there is ONE channel to assert on. No DB / no LLM —
 * `shapeMintedReport` is pure.
 *
 * Properties under test:
 *   - `minted_edges` (total) and `minted_detail` (all) count/carry every row.
 *   - Detail enrichment: full content is looked up + truncated to the slice; a missing id
 *     yields empty content (never throws); `reason` mirrors the adjudicator rationale and
 *     the legacy `rationale` alias is preserved.
 */

import { describe, test, expect } from 'vitest';

import { shapeMintedReport, type MintedEdgeRow } from '../services/belief/dryRunReport.js';

const row = (over: Partial<MintedEdgeRow> & Pick<MintedEdgeRow, 'from_id' | 'to_id' | 'edge_type'>): MintedEdgeRow => ({
  mode: 'replaced',
  confidence: '0.9',
  cosine: '0.82',
  rationale: 'status flip supersedes',
  ...over,
});

describe('shapeMintedReport', () => {
  const rows: MintedEdgeRow[] = [
    row({ from_id: 's1', to_id: 's2', edge_type: 'possibly_supersedes', rationale: 'soft one' }),
    row({ from_id: 's3', to_id: 's4', edge_type: 'possibly_supersedes', rationale: 'soft two' }),
  ];
  const content: Record<string, string> = {
    s1: 'SOFT-FROM content', s2: 'SOFT-TO content',
    s3: 'SOFT3-FROM content', // s4 intentionally absent
  };
  const contentOf = (id: string): string | undefined => content[id];

  test('counts and carries every minted row', () => {
    const r = shapeMintedReport(rows, contentOf);
    expect(r.minted_edges).toBe(2);
    expect(r.minted_detail).toHaveLength(2);
    expect(r.minted_detail.map((d) => d.from_id)).toEqual(['s1', 's3']);
  });

  test('enriches detail with content, reason (+legacy rationale), confidence, cosine', () => {
    const r = shapeMintedReport(rows, contentOf);
    const d = r.minted_detail[0];
    expect(d.from_content).toBe('SOFT-FROM content');
    expect(d.to_content).toBe('SOFT-TO content');
    expect(d.reason).toBe('soft one');
    expect(d.rationale).toBe('soft one'); // legacy alias kept
    expect(d.confidence).toBe('0.9');
    expect(d.cosine).toBe('0.82');
    expect(d.mode).toBe('replaced');
  });

  test('missing content id yields empty string, never throws', () => {
    const r = shapeMintedReport(rows, contentOf);
    const s3 = r.minted_detail.find((d) => d.from_id === 's3')!;
    expect(s3.from_content).toBe('SOFT3-FROM content');
    expect(s3.to_content).toBe(''); // s4 absent from corpus
  });

  test('honours the content slice length', () => {
    const long = 'x'.repeat(2000);
    const r = shapeMintedReport(
      [row({ from_id: 'a', to_id: 'b', edge_type: 'possibly_supersedes' })],
      () => long,
      50,
    );
    expect(r.minted_detail[0].from_content).toHaveLength(50);
  });

  test('empty input → zeroed report', () => {
    const r = shapeMintedReport([], contentOf);
    expect(r).toMatchObject({ minted_edges: 0 });
    expect(r.minted_detail).toEqual([]);
  });
});
