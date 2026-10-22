import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { costLine, parseClaudeResult } from '../src/claudeRun.js';
import { run } from '../src/run.js';
import { tick } from '../src/tick.js';
import { makeHarness, TASK_ID } from './support/worker-harness.js';

const WORKER_COST = 0.25;
const CRITIC_COST = 0.5;
const PLAN_COST = 0.0125;
const VERDICT = { verdict: 'PASS', note: 'ok', clauses: [{ index: 0, verified: true }] };

/**
 * A fake claude written by this test. It always prints a JSON result (`result` text + `total_cost_usd`);
 * the result text is the proof that the loop still reads the text out of the JSON:
 * - as the critic (evidence dir set) the verdict is ONLY in the result text, via the marker line;
 * - as the worker it commits a file;
 * - given the planner marker on stdin it prints a punch list as the result text.
 */
const fakeClaude = (planArray: string): string => `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(require('node:path').join(__dirname, 'argv'), process.argv.slice(2).join(' ') + '\\n');
const out = (result, cost) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: cost }));
if (process.env.MANDREL_LOOP_EVIDENCE_DIR) {
  out('MANDREL-LOOP-VERDICT:' + ${JSON.stringify(JSON.stringify(VERDICT))}, ${CRITIC_COST});
} else if (input.includes('PLAN-ME')) {
  out(${JSON.stringify(planArray)}, ${PLAN_COST});
} else {
  fs.writeFileSync('w.txt', 'x');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'w']);
  out('built it', ${WORKER_COST});
}
`;

describe('parseClaudeResult', () => {
  it('returns the result text and cost from a JSON result', () => {
    expect(parseClaudeResult('{"result":"hello","total_cost_usd":0.5}')).toEqual({ text: 'hello', costUsd: 0.5 });
  });
  it('passes non-JSON output through as text with no cost', () => {
    expect(parseClaudeResult('plain text')).toEqual({ text: 'plain text', costUsd: null });
  });
  it('formats one line naming role, punch and cost', () => {
    expect(costLine('critic', 'abcdef12', 0.5)).toBe('claude run: role=critic punch=abcdef12 cost=$0.5000');
  });
});

describe('every Claude run reports its cost', () => {
  it('worker and critic: still get the result text, log one line each, and the tick summary sums them', async () => {
    const h = makeHarness(fakeClaude('[]'));
    const argvLog = join(h.bin, 'argv');
    const lines: string[] = [];
    const deps = { board: h.board, config: h.config, env: h.env, err: (l: string) => void lines.push(l) };

    const t1 = await tick(deps);
    expect(t1.outcomes.map((o) => o.outcome)).toEqual(['built']);
    expect(lines).toContain(`claude run: role=worker punch=${TASK_ID.slice(0, 8)} cost=$0.2500`);
    expect(t1.costUsd).toBeCloseTo(WORKER_COST);
    expect(t1.claudeRuns).toBe(1);

    const t2 = await tick(deps);
    // The verdict reached the critic only through the JSON result text, so the PASS proves the text path.
    expect((await h.board.get(TASK_ID))!.stage).toBe('evidence');
    expect(lines).toContain(`claude run: role=critic punch=${TASK_ID.slice(0, 8)} cost=$0.5000`);
    expect(t2.costUsd).toBeCloseTo(CRITIC_COST);
    expect(t2.claudeRuns).toBe(1);
    // both runs asked claude for JSON output
    const argv = readFileSync(argvLog, 'utf8').trim().split('\n');
    expect(argv).toHaveLength(2);
    for (const a of argv) expect(a).toContain('--output-format json');
  });

  it('the run loop prints the tick total in its summary line', async () => {
    const h = makeHarness(fakeClaude('[]'));
    const lines: string[] = [];
    const cfg = join(mkdtempSync(join(tmpdir(), 'loop-cost-')), 'c.json');
    writeFileSync(cfg, JSON.stringify({ mandrel: { url: 'http://localhost:8080', project: 'p' }, models: { worker: 'w', critic: 'c' }, repos: { 'demo-repo': { path: h.repo, gate: 'true' } }, workdir: h.config.workdir }));
    const code = await run(['once', '--config', cfg], { err: (l) => lines.push(l), out: () => undefined, env: { ...h.env, MANDREL_TOKEN: 'placeholder', CLAUDE_CODE_OAUTH_TOKEN: 'placeholder', GH_TOKEN: 'placeholder' }, board: () => h.board, auth: { uid: () => 1000, ghAuthOk: () => true, fileExists: () => true } });
    expect(code, lines.join('\n')).toBe(0);
    expect(lines.some((l) => /^tick: dispatched 1, built, 1 claude run\(s\), cost \$0\.2500$/.test(l))).toBe(true);
  });

  it('plan: still gets the result text and logs the run', async () => {
    const h = makeHarness('');
    const plan = JSON.stringify([
      { title: 'T', description: 'd', size: 's', repo: 'demo-repo', dependsOnIndex: [], doneWhen: [{ text: 'works', owner: 'lane', proof: 'test/a.test.ts' }], proofKind: 'look' },
    ]);
    writeFileSync(join(h.bin, 'claude'), fakeClaude(plan));
    chmodSync(join(h.bin, 'claude'), 0o755);
    const dir = mkdtempSync(join(tmpdir(), 'loop-cost-plan-'));
    const spec = join(dir, 'spec.md');
    writeFileSync(spec, 'PLAN-ME');
    const cfg = join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ mandrel: { url: 'http://localhost:8080', project: 'p' }, models: { worker: 'w', critic: 'c' }, repos: { 'demo-repo': { path: h.repo, gate: 'true' } } }));
    const out = join(dir, 'punches.json');
    const argvLog = join(h.bin, 'argv');
    const errs: string[] = [];
    const code = await run(['plan', spec, '-o', out, '--config', cfg], {
      env: { ...h.env, MANDREL_LOOP_CLAUDE_BIN: join(h.bin, 'claude') },
      out: () => undefined,
      err: (l) => errs.push(l),
    });
    expect(code, errs.join('\n')).toBe(0);
    expect(existsSync(argvLog) && readFileSync(argvLog, 'utf8')).toContain('--output-format json');
    expect(errs).toContain('claude run: role=plan punch=- cost=$0.0125');
    expect((JSON.parse(readFileSync(out, 'utf8')) as unknown[]).length).toBe(1);
  });
});
