import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBoard } from '../src/board/fake.js';
import { applyPunches, extractJsonArray, LintRefusal } from '../src/plan.js';
import { run } from '../src/run.js';
import { FakeMandrel } from './support/fake-mandrel-mcp.js';

const fixture = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const CFG_DIR = mkdtempSync(join(tmpdir(), 'loop-apply-base-'));
const BASE_CONFIG = join(CFG_DIR, 'mandrel-loop.config.json');
writeFileSync(BASE_CONFIG, JSON.stringify({ mandrel: { url: 'http://localhost:8080', project: 'p' }, models: { worker: 'a', critic: 'b' }, repos: { 'mandrel-oss': { path: CFG_DIR, gate: 'true' } } }));
const good = JSON.parse(readFileSync(fixture('punches-good.json'), 'utf8')) as Record<string, unknown>[];

describe('plan --apply against the FakeBoard', () => {
  it('creates one draft per entry with repo tag, proofKind, source machine and resolved dependsOn', async () => {
    const board = new FakeBoard();
    const lines: string[] = [];
    const code = await run(['plan', '--apply', fixture('punches-good.json'), '--config', BASE_CONFIG], {
      out: (l) => lines.push(l),
      board: () => board,
    });
    expect(code).toBe(0);
    const drafts = await board.listStage('draft');
    expect(drafts).toHaveLength(good.length);

    const tasks = await Promise.all(drafts.map((d) => board.get(d.id)));
    const byTitle = new Map(tasks.map((t) => [t!.title, t!]));
    const ids = good.map((p) => byTitle.get(p.title as string)!.id);
    good.forEach((p, i) => {
      const t = byTitle.get(p.title as string)!;
      expect(t.stage).toBe('draft');
      expect(t.tags).toContain('repo:mandrel-oss');
      expect(t.metadata.punch?.proofKind).toBe(p.proofKind);
      expect(t.metadata.punch?.source).toBe('machine');
      expect(t.metadata.punch?.doneWhen).toEqual(p.doneWhen);
      expect(t.metadata.punch?.dependsOn).toEqual((p.dependsOnIndex as number[]).map((d) => ids[d]));
      expect(ids[i]).toBeTruthy();
    });
  });

  it('refuses an owner:lane clause with no proof and creates nothing', async () => {
    const bad = structuredClone(good);
    (bad[1]!.doneWhen as Record<string, unknown>[])[0] = { text: 'works', owner: 'lane' };
    const board = new FakeBoard();
    await expect(applyPunches(board, bad, ['mandrel-oss'])).rejects.toThrow(LintRefusal);
    await expect(applyPunches(board, bad, ['mandrel-oss'])).rejects.toThrow(/punch 1 clause 0: \[missing-proof\]/);
    expect(await board.listStage('draft')).toEqual([]);
  });

  it('exits 1 through the CLI on a refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-apply-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify([{ ...good[0], doneWhen: [{ text: 'x', owner: 'lane' }] }]));
    const errs: string[] = [];
    const board = new FakeBoard();
    const code = await run(['plan', '--apply', file, '--config', BASE_CONFIG], { err: (l) => errs.push(l), board: () => board });
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/missing-proof/);
    expect(await board.listStage('draft')).toEqual([]);
  });
});

describe('plan --apply reads the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-apply-cfg-'));
  const configFile = join(dir, 'mandrel-loop.config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      mandrel: { url: 'http://config-host:9191', project: 'config-project', tokenEnv: 'FIXTURE_TOKEN', actor: 'fixture-actor' },
      models: { worker: 'a', critic: 'b' },
      repos: { 'mandrel-oss': { path: dir, gate: 'true' } },
    }),
  );

  it('files the drafts at the config url, in the config project, with only the named token in the environment', async () => {
    const board = new FakeBoard();
    const fake = new FakeMandrel({
      token: 'tok-from-config-name',
      handle: async (c) => {
        const { action: _action, ...args } = c.args;
        return { structuredContent: { task: await board.create(args as unknown as Parameters<FakeBoard['create']>[0]) } };
      },
    });
    const fetchStub = fake.fetch;

    const lines: string[] = [];
    const code = await run(['plan', '--apply', fixture('punches-good.json'), '--config', configFile], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      env: { HOME: dir, FIXTURE_TOKEN: 'tok-from-config-name' },
      fetch: fetchStub,
    });
    expect(lines.join('\n')).toContain(`applied: ${good.length} draft(s)`);
    expect(code).toBe(0);
    expect(await board.listStage('draft')).toHaveLength(good.length);
    expect(fake.calls.map((c) => `${c.tool}.${String(c.args.action)}`)).toEqual(good.map(() => 'task.create'));
    for (const s of fake.calls) expect(s.headers.get('X-Mandrel-Project')).toBe('config-project');
    for (const s of fake.requests) {
      expect(s.url).toBe('http://config-host:9191/mcp');
      expect(s.headers.get('Authorization')).toBe('Bearer tok-from-config-name');
      expect(s.headers.get('X-Actor-ID')).toBe('fixture-actor');
    }
  });

  it('names the config-declared token variable when it is unset', async () => {
    const errs: string[] = [];
    const code = await run(['plan', '--apply', fixture('punches-good.json'), '--config', configFile], {
      err: (l) => errs.push(l),
      env: { HOME: dir },
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('FIXTURE_TOKEN is not set');
  });
});

describe('plan <spec>', () => {
  it('feeds card and spec to the runner, writes punches.json and lints it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-plan-'));
    const spec = join(dir, 'spec.md');
    const outFile = join(dir, 'punches.json');
    writeFileSync(spec, 'Build the parser.');
    let prompt = '';
    const reply = `Here you go:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    const code = await run(['plan', spec, '-o', outFile, '--config', BASE_CONFIG], {
      out: () => undefined,
      planner: () => (p) => ((prompt = p), reply),
    });
    expect(code).toBe(0);
    expect(prompt).toContain('Planner card');
    expect(prompt).toContain('Build the parser.');
    expect(JSON.parse(readFileSync(outFile, 'utf8'))).toEqual(good);
  });

  it('extractJsonArray rejects output with no array', () => {
    expect(() => extractJsonArray('nothing here')).toThrow(/no JSON array/);
  });
});
