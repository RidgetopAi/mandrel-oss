import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Claim, Task } from '../src/board.js';
import { FakeBoard } from '../src/board/fake.js';
import { buildPlannerPrompt } from '../src/plan.js';
import { run } from '../src/run.js';
import { parseConfig } from '../src/settings.js';
import { tick } from '../src/tick.js';
import type { WorkerResult } from '../src/worker.js';

const dir = mkdtempSync(join(tmpdir(), 'loop-unknown-repo-'));
const CONFIG = join(dir, 'mandrel-loop.config.json');
writeFileSync(
  CONFIG,
  JSON.stringify({
    mandrel: { url: 'http://localhost:8080', project: 'p' },
    models: { worker: 'a', critic: 'b' },
    repos: { app: { path: dir, gate: 'true' } },
  }),
);

const punch = (repo: string) => ({
  title: 'Add the parser',
  description: 'Create src/parser.ts and test/parser.test.ts.',
  size: 's',
  repo,
  dependsOnIndex: [],
  doneWhen: [{ text: 'the parser parses', owner: 'lane', proof: 'test/parser.test.ts' }],
  proofKind: 'test',
});
const write = (name: string, repo: string): string => {
  const f = join(dir, name);
  writeFileSync(f, JSON.stringify([punch(repo)]));
  return f;
};

describe('lint and plan --apply reject a punch naming an unknown repo', () => {
  it('lint names the bad repo and the valid key, and accepts the valid repo', async () => {
    const out: string[] = [];
    expect(await run(['lint', write('work.json', 'work'), '--config', CONFIG], { out: (l) => out.push(l) })).toBe(1);
    expect(out.join('\n')).toMatch(/\[unknown-repo\].*"work".*valid repos: app/);
    const ok: string[] = [];
    expect(await run(['lint', write('app.json', 'app'), '--config', CONFIG], { out: (l) => ok.push(l) })).toBe(0);
    expect(ok.join('\n')).toContain('lint: clean');
  });

  it('plan --apply refuses it, creates nothing, and applies the valid repo', async () => {
    const board = new FakeBoard();
    const errs: string[] = [];
    const bad = await run(['plan', '--apply', write('work.json', 'work'), '--config', CONFIG], {
      err: (l) => errs.push(l),
      board: () => board,
    });
    expect(bad).toBe(1);
    expect(errs.join('\n')).toMatch(/"work".*valid repos: app/);
    expect(await board.listStage('draft')).toEqual([]);
    const good = await run(['plan', '--apply', write('app.json', 'app'), '--config', CONFIG], {
      out: () => undefined,
      board: () => board,
    });
    expect(good).toBe(0);
    expect(await board.listStage('draft')).toHaveLength(1);
  });
});

describe('plan tells the planner the configured repo keys', () => {
  it('puts the keys in the prompt run through the CLI', async () => {
    const spec = join(dir, 'spec.md');
    writeFileSync(spec, 'Build the parser.');
    let prompt = '';
    await run(['plan', spec, '-o', join(dir, 'out.json'), '--config', CONFIG], {
      out: () => undefined,
      err: () => undefined,
      planner: () => (p) => ((prompt = p), '[]'),
    });
    expect(prompt).toMatch(/only configured repo key is `app`/);
    expect(prompt).toContain('Build the parser.');
  });

  it('lists every key when there are several', () => {
    expect(buildPlannerPrompt('s', ['app', 'api'], 'CARD')).toMatch(/`app`, `api`/);
  });

  it('the planner card instructs using a configured repo key', () => {
    const card = readFileSync(new URL('../cards/planner.md', import.meta.url), 'utf8');
    expect(card).toMatch(/MUST be one of the configured repo keys/);
  });
});

describe('the picker skips a punch whose repo has no config entry', () => {
  const task = (n: number, repo: string): Task => ({
    id: `0000000${n}-0000-4000-8000-000000000000`,
    title: `punch ${n}`,
    stage: 'ready',
    status: 'todo',
    priority: 'medium',
    tags: [`repo:${repo}`],
    createdAt: `2026-01-0${n}T00:00:00Z`,
    claimLive: false,
    metadata: { punch: { doneWhen: [{ text: 'works', owner: 'lane', proof: 't.test.ts' }], proofKind: 'test' } },
  });

  it('picks the newer valid punch over an older unknown-repo punch, which stays ready', async () => {
    const config = parseConfig(
      JSON.stringify({
        mandrel: { url: 'http://localhost:8080', project: 'p' },
        models: { worker: 'a', critic: 'b' },
        workdir: '/nonexistent-workdir',
        repos: { app: { path: '/nonexistent-repo', gate: 'true' } },
      }),
      '/nonexistent',
    );
    const old = task(1, 'work');
    const valid = task(2, 'app');
    const board = new FakeBoard({ tasks: [old, valid] });
    const seen: string[] = [];
    const errs: string[] = [];
    const worker = async (id: string, { board: b, claim }: { board: FakeBoard; claim: unknown }): Promise<WorkerResult> => {
      seen.push(id);
      await b.update(id, { stage: 'verifying' }, (claim as Claim).claimId);
      await b.release(id, (claim as Claim).claimId);
      return { outcome: 'built', note: 'built' };
    };
    const deps = { board, config, env: {}, err: (l: string) => errs.push(l), worker: worker as never };
    const r = await tick(deps);
    expect(seen).toEqual([valid.id]);
    expect(r.dispatched).toBe(1);
    expect((await board.get(old.id))!.stage).toBe('ready');
    await tick(deps);
    expect(errs.filter((e) => e.includes('skipping') && e.includes(old.id))).toHaveLength(1);
  });
});
