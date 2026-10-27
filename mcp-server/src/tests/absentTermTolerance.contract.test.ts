/**
 * ABSENT-TERM TOLERANCE — end-to-end over a seeded corpus.
 *
 * The REAL smartSearchHandler against a migrated Postgres (embeddings stubbed, as in
 * hybridSearch.contract.test.ts). Corpus: a small set of records about a business trip on
 * the 7th. One unfamiliar word — a typo, an ordinal, a quoted identifier — must not empty
 * the results; a short question whose only substantive term is absent still returns empty.
 * The decision logic itself is covered DB-free in absentTermTolerance.unit.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding, activeEmbeddingColumn } from './helpers/embedGeometry.js';

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding(), dimensions: embedDim(), model: 'mock' })),
  },
}));

// A pass-through spy on the fallback scan, so a test can assert WHETHER it ran.
vi.mock('../services/absentTerms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/absentTerms.js')>();
  return { ...real, fetchProjectNearMissVocabulary: vi.fn(real.fetchProjectNearMissVocabulary) };
});

import { db } from '../config/database.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';
import { fetchProjectNearMissVocabulary } from '../services/absentTerms.js';

const STAMP = Date.now();
let project: string;
let tripId: string;
let fbProject: string;
let tagId: string;

const search = (q: string) => smartSearchHandler.smartSearchDetailed(project, q, undefined, 10);

describe('smart_search tolerates one unfamiliar word', () => {
  beforeAll(async () => {
    project = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1,'tolerance') RETURNING id`, [`tol-${STAMP}`],
    )).rows[0].id;
    const ins = async (content: string) =>
      (await db.query(
        `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
         VALUES ($1,'note',$2,$3::vector) RETURNING id`,
        [project, content, `[${patternEmbedding().join(',')}]`],
      )).rows[0].id as string;
    await ins('Quarterly budget review notes for the finance team, nothing about travel.');
    await ins('The office printer was replaced and the network cabling was labelled.');
    tripId = await ins('Business trip to Denver on the 7th: flew out in the morning and met the client about the contract renewal.');

    // FALLBACK PROJECT: "business" lives ONLY in a decision's rationale — indexed in search_tsv,
    // but not in the title/summary the retrieved-row vocabulary reads. So only the whole-project
    // lexeme fallback can see that "buisiness" is a typo.
    fbProject = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1,'tolerance-fallback') RETURNING id`, [`tolfb-${STAMP}`],
    )).rows[0].id;
    await db.query(
      `INSERT INTO technical_decisions (project_id, decision_type, title, description, rationale, impact_level)
       VALUES ($1, 'process', 'Expense policy', 'Reimbursement rules', 'Covers business travel only', 'low')`,
      [fbProject],
    );
    // A record found by its TAG alone: the tag word occurs in no record's text, so the
    // absent-term probe calls it absent until reconciliation sees the record resolved by it.
    tagId = (await db.query(
      `INSERT INTO contexts (project_id, context_type, content, tags, ${activeEmbeddingColumn()})
       VALUES ($1,'note',$2,ARRAY['zorblaxian'],$3::vector) RETURNING id`,
      [fbProject, 'Notes from the vendor call.', `[${patternEmbedding().join(',')}]`],
    )).rows[0].id;
  });

  afterAll(async () => {
    try { await db.query('DELETE FROM contexts WHERE project_id = $1', [project]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [fbProject]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM contexts WHERE project_id = $1', [fbProject]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[project, fbProject]]); } catch { /* ignore */ }
    await db.end();
  });

  const expectTripTop3 = async (q: string) => {
    const out = await search(q);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.slice(0, 3).map((r) => r.id)).toContain(tripId);
  };

  test('a typo ("buisiness") does not empty the results', () => expectTripTop3('When was my buisiness trip to Denver?'));
  test('an ordinal ("7th") does not empty the results', () => expectTripTop3('What did I do on the 7th during the trip?'));
  test('an ordinal absent from the corpus ("27th") does not empty the results', () => expectTripTop3('What did I do on the 27th during the trip to Denver?'));
  test('one unknown identifier in a long question does not empty the results', () =>
    expectTripTop3('Which client did I meet in Denver on the business trip about the contract renewal SIAC_GEE?'));

  test('a short question whose only substantive term is absent still returns empty', async () => {
    const out = await search('kubernetes setup?');
    expect(out.results).toEqual([]);
    expect(out.emptyReason?.kind).toBe('absent_terms');
  });

  test('a filler word ("yesterday") beside one unknown name does not empty the results (C6)', () =>
    expectTripTop3('kubernetes client contract renewal Denver yesterday'));

  test('a lone typo the retrieved rows cannot explain is rescued by the whole-project fallback', async () => {
    const out = await smartSearchHandler.smartSearchDetailed(fbProject, 'buisiness', undefined, 10);
    expect(out.emptyReason?.kind).not.toBe('absent_terms');
    expect(out.absentTerms?.[0]).toMatchObject({ term: 'buisiness', nearMissOf: 'busi', exempt: 'near-miss' });
  });

  test('a bare-tag lookup that resolves never pays for the fallback scan', async () => {
    const spy = vi.mocked(fetchProjectNearMissVocabulary);
    spy.mockClear();
    const out = await smartSearchHandler.smartSearchDetailed(fbProject, 'zorblaxian', undefined, 10);
    expect(out.results.map((r) => r.id)).toContain(tagId);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  test('a FAILED fallback leaves the veto standing and names itself in degradedSources', async () => {
    const spy = vi.mocked(fetchProjectNearMissVocabulary);
    spy.mockClear();
    spy.mockRejectedValueOnce(new Error('injected fallback failure'));
    const out = await smartSearchHandler.smartSearchDetailed(fbProject, 'kubernetes', undefined, 10);
    expect(spy).toHaveBeenCalledTimes(1); // the failing path ran
    expect(out.results).toEqual([]);
    expect(out.emptyReason?.kind).toBe('absent_terms');
    expect(out.degradedSources).toContain('near-miss-fallback');
  });

  test('the fallback does not rescue a real unknown name', async () => {
    vi.mocked(fetchProjectNearMissVocabulary).mockClear();
    const out = await smartSearchHandler.smartSearchDetailed(fbProject, 'kubernetes', undefined, 10);
    expect(out.emptyReason?.kind).toBe('absent_terms');
    expect(fetchProjectNearMissVocabulary).toHaveBeenCalledTimes(1); // control: the spy can see a call
  });
});
