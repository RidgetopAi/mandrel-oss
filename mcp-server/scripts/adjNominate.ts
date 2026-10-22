#!/usr/bin/env node
/**
 * adjNominate — Phase-4 adjudicator DECISION run, STAGE 1 (nomination).
 *
 * Seeds a DISPOSABLE, already-migrated DB with a REAL sample of the riverbend corpus
 * (contexts + decisions, pulled read-only from prod with their gemma vectors — copied
 * verbatim, NOT re-embedded, so geometry is byte-identical to prod), then runs the REAL
 * Stage-1 candidatePairing (findCandidates) over every record to NOMINATE the candidate
 * pairs the belief layer would actually adjudicate. Reports nomination stats + the cosine
 * distribution, and writes the (deduped, optionally sampled) pairs to pairs.json for the
 * scoring stage. NEVER touches prod (writes only to the ci_* disposable DB in DATABASE_*).
 *
 * Env:
 *   ADJRUN_CORPUS   path to corpus.json (array of {id,type,content,created_at,emb})
 *   ADJRUN_OUT      output dir (pairs.json + nomination-stats.json)
 *   ADJRUN_SAMPLE   max pairs to keep for scoring (0 = keep all). Default 0.
 *   ADJRUN_SEED     RNG seed for the representative sample. Default 42.
 *   MANDREL_EMBEDDER must be gemma (so activeEmbeddingColumn()=embedding_gemma).
 */

import fs from 'fs/promises';
import path from 'path';

import { db, initializeDatabase, closeDatabase } from '../src/config/database.js';
import {
  activeEmbedderKey,
  activeEmbeddingColumn,
} from '../src/config/embeddingConfig.js';
import { BELIEF_CONFIG } from '../src/config/beliefConfig.js';
import type { EdgeNodeType } from '../src/config/edgeTypes.js';
import { findCandidates } from '../src/services/belief/candidatePairing.js';

interface CorpusRow {
  id: string;
  type: EdgeNodeType;
  content: string;
  created_at: string;
  emb: string; // pgvector text literal "[...]"
}

interface PairOut {
  a: { id: string; type: EdgeNodeType; content: string; createdAt: string };
  b: { id: string; type: EdgeNodeType; content: string; createdAt: string };
  cosine: number;
}

const CORPUS = process.env.ADJRUN_CORPUS!;
const OUT = process.env.ADJRUN_OUT!;
const SAMPLE = Number(process.env.ADJRUN_SAMPLE ?? '0');
const SEED = Number(process.env.ADJRUN_SEED ?? '42');

/** Deterministic LCG for a reproducible representative sample. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedProject(): Promise<string> {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1,$2) RETURNING id::text AS id`,
    ['adj-decision-run', 'Phase-4 adjudicator decision run — real riverbend sample']
  );
  return r.rows[0].id;
}

async function seedRow(projectId: string, row: CorpusRow): Promise<void> {
  if (row.type === 'context') {
    await db.query(
      `INSERT INTO contexts (id, project_id, context_type, content, ${activeEmbeddingColumn()}, created_at)
       VALUES ($1::uuid,$2,$3,$4,$5::vector,$6)`,
      [row.id, projectId, 'completion', row.content, row.emb, row.created_at]
    );
  } else {
    await db.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, ${activeEmbeddingColumn()}, decision_date)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::vector,$8)`,
      [row.id, projectId, 'architecture', row.content.slice(0, 60), row.content, row.content, row.emb, row.created_at]
    );
  }
}

function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

async function main(): Promise<void> {
  await initializeDatabase();
  if (activeEmbedderKey() !== 'gemma') {
    throw new Error(`Active embedder is "${activeEmbedderKey()}", need gemma. Set MANDREL_EMBEDDER=gemma.`);
  }
  const corpus = JSON.parse(await fs.readFile(CORPUS, 'utf-8')) as CorpusRow[];
  console.log(`🌱 Seeding ${corpus.length} real records into disposable DB (column=${activeEmbeddingColumn()})…`);

  const projectId = await seedProject();
  const byId = new Map<string, CorpusRow>();
  let n = 0;
  for (const row of corpus) {
    await seedRow(projectId, row);
    byId.set(row.id, row);
    if (++n % 200 === 0) console.log(`   seeded ${n}/${corpus.length}`);
  }
  console.log(`   seeded ${n}/${corpus.length}`);

  // Stage-1 nomination over EVERY record (the real pairing the belief layer would run).
  console.log(
    `🔎 Nominating with findCandidates (pairMinCosine=${BELIEF_CONFIG.pairMinCosine}, pairTopK=${BELIEF_CONFIG.pairTopK})…`
  );
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const pairs = new Map<string, { aId: string; bId: string; cosine: number }>();
  let sources = 0;
  // A pairing query that THROWS is fail-open and yields no candidate. Counting it keeps this
  // report from presenting a partial nomination as a complete one.
  let pairingFailures = 0;
  let firstPairingFailure = '';
  for (const row of corpus) {
    const pairing = await findCandidates({ id: row.id, type: row.type, projectId }, BELIEF_CONFIG);
    if (!pairing.ok) {
      pairingFailures += 1;
      firstPairingFailure =
        firstPairingFailure || `${pairing.reason.stage} (${pairing.reason.subject}): ${pairing.reason.message}`;
    }
    // The failure arm names its list `partial`, so this read cannot skip the `.ok` test above.
    for (const c of (pairing.ok ? pairing.candidates : pairing.partial)) {
      if (c.id === row.id) continue;
      const k = pairKey(row.id, c.id);
      const prev = pairs.get(k);
      if (!prev || c.cosine > prev.cosine) pairs.set(k, { aId: row.id, bId: c.id, cosine: c.cosine });
    }
    if (++sources % 200 === 0) console.log(`   nominated over ${sources}/${corpus.length} sources`);
  }

  if (pairingFailures > 0) {
    console.warn(
      `⚠️  ${pairingFailures}/${corpus.length} sources had a FAILED pairing query — this nomination is INCOMPLETE. First: ${firstPairingFailure}`
    );
  }
  const allPairs = [...pairs.values()];
  const cosines = allPairs.map((p) => p.cosine).sort((a, b) => a - b);
  const dist = {
    total_pairs: allPairs.length,
    min: cosines[0] ?? null,
    p10: pctl(cosines, 10),
    p25: pctl(cosines, 25),
    p50: pctl(cosines, 50),
    p75: pctl(cosines, 75),
    p90: pctl(cosines, 90),
    max: cosines[cosines.length - 1] ?? null,
    buckets: {
      '0.40-0.50': cosines.filter((c) => c >= 0.4 && c < 0.5).length,
      '0.50-0.60': cosines.filter((c) => c >= 0.5 && c < 0.6).length,
      '0.60-0.70': cosines.filter((c) => c >= 0.6 && c < 0.7).length,
      '0.70-0.80': cosines.filter((c) => c >= 0.7 && c < 0.8).length,
      '0.80-0.90': cosines.filter((c) => c >= 0.8 && c < 0.9).length,
      '0.90-1.00': cosines.filter((c) => c >= 0.9).length,
    },
  };

  // Representative sample for scoring (stratified by cosine bucket, deterministic RNG).
  let chosen = allPairs;
  if (SAMPLE > 0 && allPairs.length > SAMPLE) {
    const rng = mulberry32(SEED);
    // stratify into the same buckets, sample proportionally
    const groups: Record<string, typeof allPairs> = {};
    for (const p of allPairs) {
      const b = Math.floor(p.cosine * 10) / 10;
      const key = b.toFixed(1);
      (groups[key] ??= []).push(p);
    }
    chosen = [];
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      const take = Math.max(1, Math.round((g.length / allPairs.length) * SAMPLE));
      // shuffle deterministically
      for (let i = g.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [g[i], g[j]] = [g[j], g[i]];
      }
      chosen.push(...g.slice(0, take));
    }
    // trim/pad to SAMPLE
    chosen = chosen.slice(0, SAMPLE);
  }

  const pairOut: PairOut[] = chosen
    .sort((a, b) => b.cosine - a.cosine)
    .map((p) => {
      const a = byId.get(p.aId)!;
      const b = byId.get(p.bId)!;
      return {
        a: { id: a.id, type: a.type, content: a.content, createdAt: a.created_at },
        b: { id: b.id, type: b.type, content: b.content, createdAt: b.created_at },
        cosine: p.cosine,
      };
    });

  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'pairs.json'), JSON.stringify(pairOut, null, 2));
  await fs.writeFile(
    path.join(OUT, 'nomination-stats.json'),
    JSON.stringify(
      { seeded: corpus.length, sources, config: BELIEF_CONFIG, distribution: dist, sampled_for_scoring: pairOut.length },
      null,
      2
    )
  );

  console.log(`\n===== NOMINATION =====`);
  console.log(`seeded records:      ${corpus.length}`);
  console.log(`unique nominated pairs: ${allPairs.length}`);
  console.log(`cosine  min/p25/p50/p75/max: ${dist.min?.toFixed(3)}/${dist.p25.toFixed(3)}/${dist.p50.toFixed(3)}/${dist.p75.toFixed(3)}/${dist.max?.toFixed(3)}`);
  console.log(`buckets:`, dist.buckets);
  console.log(`sampled for scoring: ${pairOut.length} -> ${path.join(OUT, 'pairs.json')}`);

  await closeDatabase();
}

main().catch(async (e) => {
  console.error('adjNominate failed:', e);
  try { await closeDatabase(); } catch { /* ignore */ }
  process.exit(2);
});
