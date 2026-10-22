/**
 * COMPILED COST ROLLUP. The image has no tsx/npx, so the cost report must ship as
 * plain JavaScript that `node` alone can run, and scripts/belief-cost.sh must invoke exactly that.
 *
 * Builds the server with the PRODUCTION build config (tsconfig.build.json) into a scratch dir, then:
 *   (1) asserts the build contains dist/cli/beliefCostMain.js and the script runs it with node only;
 *   (2) loads the COMPILED rollup (not the .ts) against a seeded ledger and asserts today's spend,
 *       the cap and a cap-reached indicator that flips exactly at the cap.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import type { BeliefCostConfig } from '../config/beliefCostConfig.js';

const MCP_DIR = resolve(__dirname, '..', '..');
const SCRIPT = resolve(MCP_DIR, '..', 'scripts', 'belief-cost.sh');
const CACHE = join(MCP_DIR, 'node_modules', '.cache');

let outDir = '';

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true });
  outDir = mkdtempSync(join(CACHE, 'belief-cost-build-'));
  execFileSync(
    join(MCP_DIR, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.build.json', '--outDir', outDir, '--incremental', 'false'],
    { cwd: MCP_DIR, stdio: 'pipe' }
  );
}, 240_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('cost rollup ships as plain JavaScript', () => {
  it('the build contains the rollup entry as .js with no TypeScript left in it', () => {
    const entry = join(outDir, 'cli', 'beliefCostMain.js');
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(join(outDir, 'cli', 'beliefCost.js'))).toBe(true);
    const text = readFileSync(entry, 'utf8');
    expect(text).toMatch(/runBeliefCost/);
    expect(text).not.toMatch(/:\s*Promise<void>/); // type annotations were erased
  });

  it('scripts/belief-cost.sh runs the compiled entry with node — no npx, no tsx', () => {
    const sh = readFileSync(SCRIPT, 'utf8');
    const code = sh.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).toMatch(/node\s+"\$ENTRY"/);
    expect(sh).toMatch(/ENTRY="dist\/cli\/beliefCostMain\.js"/);
    expect(code).not.toMatch(/\bnpx\b/);
    expect(code).not.toMatch(/\btsx\b/);
  });

  it('the Dockerfile compiles dist/ and copies it into the runtime image', () => {
    const df = readFileSync(join(MCP_DIR, 'Dockerfile'), 'utf8');
    expect(df).toMatch(/RUN npx tsc -p tsconfig\.build\.json/);
    expect(df).toMatch(/COPY --from=builder \/app\/dist \.\/dist/);
  });
});

// ── the compiled rollup against a seeded ledger ──────────────────────────────────────────────────

const CFG = (cap: number): BeliefCostConfig => ({
  rates: {},
  alertUsdPerDay: 100,
  rollupWindowDays: 7,
  dailySpendCapUsd: cap,
});

/** A pool holding a seeded ledger: today's rows only, answering the rollup's two queries. */
function seededPool(todayCosts: number[]): Pool {
  const today = new Date().toISOString().slice(0, 10);
  const total = todayCosts.reduce((a, b) => a + b, 0);
  return {
    async query(sql: string) {
      if (/LEFT JOIN projects/i.test(sql)) return { rows: [], rowCount: 0 };
      return {
        rows: todayCosts.length
          ? [{ day: today, provider: 'anthropic', model: 'm', calls: todayCosts.length, input_tokens: 10,
               output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: total }]
          : [],
        rowCount: 1,
      };
    },
  } as unknown as Pool;
}

async function runCompiled(pool: Pool, cfg: BeliefCostConfig, argv: string[] = []): Promise<string> {
  const mod = await import(pathToFileURL(join(outDir, 'cli', 'beliefCost.js')).href);
  let out = '';
  await mod.runBeliefCost(argv, pool, (t: string) => (out += t), cfg);
  return out;
}

describe('compiled rollup against a seeded ledger', () => {
  it('JSON: today, the cap and capReached — false below, true at, true over', async () => {
    const below = JSON.parse(await runCompiled(seededPool([0.6, 0.9]), CFG(2), ['--json']));
    expect(below.todayUsd).toBeCloseTo(1.5, 6);
    expect(below.dailySpendCapUsd).toBe(2);
    expect(below.capReached).toBe(false);

    const at = JSON.parse(await runCompiled(seededPool([1, 1]), CFG(2), ['--json']));
    expect(at.todayUsd).toBe(2);
    expect(at.capReached).toBe(true);

    const over = JSON.parse(await runCompiled(seededPool([3]), CFG(2), ['--json']));
    expect(over.todayUsd).toBe(3);
    expect(over.capReached).toBe(true);
  });

  it('a cap of 0 means no cap: never reached', async () => {
    const r = JSON.parse(await runCompiled(seededPool([50]), CFG(0), ['--json']));
    expect(r.capReached).toBe(false);
  });

  it('human output states today\'s spend, the cap and the cap-reached indicator', async () => {
    const hit = await runCompiled(seededPool([2.5]), CFG(2));
    expect(hit).toMatch(/Spend cap: \$2\.5000 of \$2\.0000 today/);
    expect(hit).toMatch(/capReached=true/);
    const ok = await runCompiled(seededPool([0.5]), CFG(2));
    expect(ok).toMatch(/Spend cap: \$0\.5000 of \$2\.0000 today/);
    expect(ok).toMatch(/capReached=false/);
  });
});
