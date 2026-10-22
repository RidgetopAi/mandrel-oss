#!/usr/bin/env node
/**
 * belief-eval — the Phase-4 belief-layer DYNO (design ca9a33c0 §5, scorecard 4a2f3e55).
 *
 * The metric-first, LLM-scored run (embedder-bake-off pattern). Seeds the six labeled
 * cases (real Mandrel record content) into a DISPOSABLE, already-migrated DB, embeds them
 * with the active embedder (gemma), then runs the REAL two-stage pipeline —
 * Stage-1 cosine candidate gate + Stage-2 adjudicator + derive + mint — and scores:
 *   ① supersession accuracy (cases 1, 2, 4 — right edge, right direction, right mode)
 *   ② conflict precision   (cases 3, 6 — NO edge minted)
 *   ③ Contested recall     (case 5 — DEFERRED to Increment 3; slot present, not scored)
 *
 * NEVER touches prod: it runs against whatever DATABASE_* env points at — the wrapper
 * (evals/belief-eval/run.sh) points it at a ci_*-prefixed throwaway DB and drops it after.
 *
 * Reproduce:  bash evals/belief-eval/run.sh
 * Output:     evals/belief-eval/out/result-<timestamp>.json  (+ a console summary)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { db, initializeDatabase, closeDatabase } from '../src/config/database.js';
import { embeddingService } from '../src/services/embedding/index.js';
import {
  activeEmbedder,
  activeEmbedderKey,
  activeEmbeddingColumn,
} from '../src/config/embeddingConfig.js';
import { BELIEF_CONFIG, BELIEF_ADJUDICATOR_CONFIG } from '../src/config/beliefConfig.js';
import type { EdgeNodeType } from '../src/config/edgeTypes.js';
import { getAdjudicationProvider } from '../src/services/belief/provider.js';
import { adjudicatePair } from '../src/services/belief/beliefAdjudicator.js';
import { findCandidates } from '../src/services/belief/candidatePairing.js';
import type { AdjudicationRecord } from '../src/services/belief/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.join(__dirname, '..', '..', 'evals', 'belief-eval');
const CASES_FILE = path.join(EVAL_DIR, 'cases.json');
const OUT_DIR = path.join(EVAL_DIR, 'out');

interface FixtureRecord {
  id_ref: string;
  type: EdgeNodeType;
  created_at: string;
  content: string;
}
interface FixtureCase {
  case: number;
  name: string;
  a: string;
  b: string | null;
  axis: number;
  deferred?: string;
  expect: { action: string; from?: string; to?: string; mode?: string };
}
interface CasesFile {
  records: Record<string, FixtureRecord>;
  cases: FixtureCase[];
}

/** A seeded record: fixture key → real DB uuid + the AdjudicationRecord shape. */
interface Seeded {
  key: string;
  rec: AdjudicationRecord;
}

async function seedProject(): Promise<string> {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id::text AS id`,
    ['belief-eval', 'Phase-4 belief-eval disposable fixtures']
  );
  return r.rows[0].id;
}

async function embed(text: string): Promise<string> {
  const v = await embeddingService.generateEmbedding({ text, role: 'document' });
  return `[${v.embedding.join(',')}]`;
}

async function seedRecord(
  projectId: string,
  fx: FixtureRecord
): Promise<AdjudicationRecord> {
  const vec = await embed(fx.content);
  if (fx.type === 'context') {
    const r = await db.query(
      `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()}, created_at)
       VALUES ($1, $2, $3, $4::vector, $5) RETURNING id::text AS id, created_at`,
      [projectId, 'completion', fx.content, vec, fx.created_at]
    );
    return { id: r.rows[0].id, type: 'context', content: fx.content, createdAt: r.rows[0].created_at };
  }
  // decision → technical_decisions (content = rationale, the column candidatePairing reads)
  const r = await db.query(
    `INSERT INTO technical_decisions
       (project_id, decision_type, title, description, rationale, ${activeEmbeddingColumn()}, decision_date)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7) RETURNING id::text AS id, decision_date AS created_at`,
    [projectId, 'architecture', fx.content.slice(0, 60), fx.content, fx.content, vec, fx.created_at]
  );
  return { id: r.rows[0].id, type: 'decision', content: fx.content, createdAt: r.rows[0].created_at };
}

function fmt(s: string): string {
  return s.length > 8 ? s.slice(0, 8) : s;
}

async function main(): Promise<void> {
  const raw = JSON.parse(await fs.readFile(CASES_FILE, 'utf-8')) as CasesFile;
  await initializeDatabase();

  if (activeEmbedderKey() !== 'gemma') {
    console.warn(
      `⚠️  Active embedder is "${activeEmbedderKey()}", not gemma — set MANDREL_EMBEDDER=gemma. ` +
        `Continuing with column ${activeEmbeddingColumn()}.`
    );
  }

  const projectId = await seedProject();
  console.log(`🌱 Seeding ${Object.keys(raw.records).length} records (embedder=${activeEmbedder().label})…`);
  const seeded = new Map<string, Seeded>();
  for (const [key, fx] of Object.entries(raw.records)) {
    const rec = await seedRecord(projectId, fx);
    seeded.set(key, { key, rec });
  }

  const provider = getAdjudicationProvider();
  console.log(`🧪 Adjudicator: ${provider.name}/${provider.model} · pairMinCosine=${BELIEF_CONFIG.pairMinCosine}\n`);

  const caseResults: any[] = [];
  const axisPass: Record<number, { pass: number; total: number }> = {
    1: { pass: 0, total: 0 },
    2: { pass: 0, total: 0 },
    3: { pass: 0, total: 0 },
  };

  for (const c of raw.cases) {
    const aSeed = seeded.get(c.a)!;

    // Deferred (axis-3 / no partner): record the slot, do not score.
    if (c.b === null || c.deferred) {
      console.log(`— case ${c.case} (axis ${c.axis}) "${c.name}": DEFERRED (${c.deferred ?? 'no partner'})`);
      caseResults.push({ case: c.case, name: c.name, axis: c.axis, scored: false, deferred: c.deferred ?? true });
      continue;
    }

    const bSeed = seeded.get(c.b)!;

    // Stage-1 candidate recall: did the cosine gate NOMINATE the partner for the source?
    const pairing = await findCandidates(
      { id: aSeed.rec.id, type: aSeed.rec.type, projectId },
      BELIEF_CONFIG
    );
    if (!pairing.ok) {
      // Say so: otherwise a failed pairing query scores as "the gate did not nominate it",
      // which is a recall result and not what happened.
      console.warn(
        `⚠️  pairing FAILED for ${aSeed.rec.id} — recall for this case is not measured. ` +
          `${pairing.reason.stage} (${pairing.reason.subject}): ${pairing.reason.message}`
      );
    }
    const nominated = (pairing.ok ? pairing.candidates : pairing.partial).find(
      (x) => x.id === bSeed.rec.id
    );

    // Stage-2 adjudication (the scored step) + derive + mint.
    const res = await adjudicatePair(
      aSeed.rec,
      bSeed.rec,
      { cosine: nominated?.cosine ?? null, projectId, provider },
      db
    );

    // Score against the expectation.
    let pass = false;
    const exp = c.expect;
    if (exp.action === 'soft_possibly_superseded') {
      const wantFrom = seeded.get(exp.from!)!.rec.id;
      const wantTo = seeded.get(exp.to!)!.rec.id;
      pass =
        res.outcome.action === 'soft_possibly_superseded' &&
        res.outcome.fromId === wantFrom &&
        res.outcome.toId === wantTo &&
        res.outcome.mode === exp.mode;
    } else if (exp.action === 'none') {
      pass = res.outcome.action === 'none';
    }

    axisPass[c.axis].total += 1;
    if (pass) axisPass[c.axis].pass += 1;

    const dir =
      res.outcome.action === 'soft_possibly_superseded'
        ? `${fmt(res.outcome.fromId)}→${fmt(res.outcome.toId)} mode=${res.outcome.mode}`
        : `none(${(res.outcome as any).reason})`;
    console.log(
      `${pass ? '✓' : '✗'} case ${c.case} (axis ${c.axis}) "${c.name}"\n` +
        `    stage1: ${nominated ? `nominated cos=${nominated.cosine.toFixed(3)}` : 'NOT nominated'} | ` +
        `verdict=${res.verdict.verdict}/${res.verdict.direction}/${res.verdict.mode} ` +
        `conf=${res.verdict.confidence.toFixed(2)} same_subj=${res.verdict.sameSubject}\n` +
        `    outcome: ${dir} | want: ${exp.action}${exp.from ? ` ${exp.from}→${exp.to} mode=${exp.mode}` : ''}`
    );

    caseResults.push({
      case: c.case,
      name: c.name,
      axis: c.axis,
      scored: true,
      pass,
      stage1_nominated: !!nominated,
      stage1_cosine: nominated?.cosine ?? null,
      verdict: res.verdict,
      outcome: res.outcome,
      minted_edge_id: res.mintedEdgeId,
      edge_created: res.edgeCreated,
    });
  }

  // Minted edges audit (should be exactly the cases-1/2/4 supersedes, nothing else).
  const edges = await db.query(
    `SELECT from_id::text AS from_id, to_id::text AS to_id, edge_type, metadata->>'mode' AS mode,
            metadata->>'confidence' AS confidence, created_by
       FROM links WHERE created_by = 'auto:belief-adjudicator' ORDER BY created_at`
  );

  const axis1 = axisPass[1];
  const axis2 = axisPass[2];
  const gatePass = axis1.pass === axis1.total && axis2.pass === axis2.total;

  const report = {
    timestamp: new Date().toISOString(),
    gate_pass: gatePass,
    axes: {
      '1_supersession_accuracy': `${axis1.pass}/${axis1.total}`,
      '2_conflict_precision': `${axis2.pass}/${axis2.total}`,
      '3_contested_recall': 'DEFERRED (Increment 3)',
    },
    minted_edges: edges.rows,
    minted_edge_count: edges.rowCount,
    config_snapshot: {
      belief: BELIEF_CONFIG,
      adjudicator: { ...BELIEF_ADJUDICATOR_CONFIG },
      embedder: { key: activeEmbedderKey(), label: activeEmbedder().label, column: activeEmbeddingColumn() },
    },
    cases: caseResults,
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `result-${Date.now()}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2));

  console.log(`\n===== BELIEF-EVAL RESULT =====`);
  console.log(`① supersession accuracy (cases 1,2,4): ${axis1.pass}/${axis1.total}`);
  console.log(`② conflict precision   (cases 3,6):   ${axis2.pass}/${axis2.total}`);
  console.log(`③ contested recall     (case 5):      DEFERRED (Inc-3)`);
  console.log(`minted belief edges: ${edges.rowCount} (want 3 — cases 1,2,4)`);
  console.log(`GATE (①&② all pass): ${gatePass ? 'PASS ✅' : 'FAIL ❌'}`);
  console.log(`report: ${outFile}`);

  await closeDatabase();
  process.exit(gatePass ? 0 : 1);
}

main().catch(async (e) => {
  console.error('belief-eval failed:', e);
  try {
    await closeDatabase();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
