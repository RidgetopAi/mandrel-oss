import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeBoard } from '../src/board/fake.js';
import type { Task } from '../src/board.js';
import { PLAN_CONFIG } from '../src/config.js';
import { run } from '../src/run.js';
import { makeHarness, noopClaude } from './support/worker-harness.js';
import { readVersion } from '../src/version.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version: string; bin: Record<string, string> };

describe('version', () => {
  it('reads the version field of loop/package.json', () => {
    expect(readVersion()).toBe(pkg.version);
  });

  it('rejects a package.json with no version', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'loop-version-')), 'package.json');
    writeFileSync(file, '{}');
    expect(() => readVersion(pathToFileURL(file))).toThrow(/version/);
  });

  it('declares the mandrel-loop bin', () => {
    expect(pkg.bin['mandrel-loop']).toBe('./dist/cli.js');
  });
});

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/punch-contract.golden.json', import.meta.url), 'utf8'),
) as { stages: string[] };

const ROOT = mkdtempSync(join(tmpdir(), 'loop-cli-'));
const CONFIG = join(ROOT, 'mandrel-loop.config.json');
writeFileSync(
  CONFIG,
  JSON.stringify({ mandrel: { url: 'http://localhost:8080', project: 'p' }, models: { worker: 'a', critic: 'b' }, tickSeconds: 7 }),
);

const row = (n: number, stage: Task['stage']): Task => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  title: `t${n}`,
  stage,
  status: 'todo',
  priority: 'medium',
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  claimLive: false,
  metadata: {},
});

async function exec(argv: string[], extra: Parameters<typeof run>[1] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: { HOME: ROOT }, ...extra });
  return { code, out, err };
}

describe('status', () => {
  it('prints exactly one line per golden stage with the count of punches at that stage', async () => {
    const board = new FakeBoard({ tasks: [row(1, 'ready'), row(2, 'ready'), row(3, 'merged'), row(4, 'evidence')] });
    const r = await exec(['status', '--config', CONFIG], { board: () => board });
    expect(r.code).toBe(0);
    const counts: Record<string, number> = { ready: 2, merged: 1, evidence: 1 };
    expect(r.out).toEqual(golden.stages.map((s) => `${s}: ${counts[s] ?? 0}`));
  });
});

describe('service --print', () => {
  for (const target of ['linux', 'macos']) {
    it(`${target}: embeds the resolved config path and the mandrel-loop command, writes nothing`, async () => {
      const r = await exec(['service', '--print', target, '--config', CONFIG], { cliPath: '/usr/local/bin/mandrel-loop' });
      expect(r.code).toBe(0);
      const text = r.out.join('\n');
      expect(text).toContain(resolve(CONFIG));
      expect(text).toContain('mandrel-loop run');
    });
  }

  it('rejects an unknown target', async () => {
    const r = await exec(['service', '--print', 'windows', '--config', CONFIG]);
    expect(r.code).toBe(2);
  });
});

describe('run / once', () => {
  const auth = { uid: () => 1000, ghAuthOk: () => true, fileExists: () => true };
  const env = { HOME: ROOT, MANDREL_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' };

  it('once sweeps a single time', async () => {
    const r = await exec(['once', '--config', CONFIG], { board: () => new FakeBoard(), env, auth });
    expect(r.code).toBe(0);
    expect(r.err.filter((l) => l.startsWith('tick:'))).toHaveLength(1);
  });

  it('run ticks every tickSeconds until the signal aborts', async () => {
    const ctl = new AbortController();
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      if (waits.length === 3) ctl.abort();
    };
    const r = await exec(['run', '--config', CONFIG], { board: () => new FakeBoard(), env, auth, signal: ctl.signal, sleep });
    expect(r.code).toBe(0);
    expect(waits).toEqual([7000, 7000, 7000]);
    expect(r.err.filter((l) => l.startsWith('tick:'))).toHaveLength(3);
  });
});

describe('ready', () => {
  const draft = (): Task => ({
    ...row(5, 'draft'),
    metadata: { punch: { doneWhen: [{ text: 'it works', owner: 'lane', proof: 'test/x.test.ts' }], proofKind: 'test' } },
  });

  it('moves a draft with no dependencies to ready', async () => {
    const d = draft();
    const board = new FakeBoard({ tasks: [d] });
    const r = await exec(['ready', d.id, '--config', CONFIG], { board: () => board });
    expect(r.code).toBe(0);
    expect((await board.get(d.id))!.stage).toBe('ready');
    expect(r.out.join('\n')).toContain(d.id);
  });

  it('refuses a punch that is not a draft, and an unknown id', async () => {
    const board = new FakeBoard({ tasks: [row(1, 'merged')] });
    const notDraft = await exec(['ready', row(1, 'merged').id, '--config', CONFIG], { board: () => board });
    expect(notDraft.code).toBe(1);
    expect(notDraft.err.join('\n')).toMatch(/only draft/);
    const unknown = await exec(['ready', 'nope', '--config', CONFIG], { board: () => board });
    expect(unknown.code).toBe(1);
    expect(unknown.err.join('\n')).toMatch(/not found/);
  });
});

describe('help', () => {
  for (const argv of [['--help'], ['-h'], ['help']]) {
    it(`${argv.join(' ')} prints usage and exits 0`, async () => {
      const r = await exec(argv);
      expect(r.code).toBe(0);
      expect(r.out.join('\n')).toContain('usage: mandrel-loop');
      expect(r.err).toEqual([]);
    });
  }

  it('an unknown command still exits 2', async () => {
    expect((await exec(['bogus'])).code).toBe(2);
  });
});

describe('status into a closed pipe', () => {
  it('exits 0 with no error output when the reader goes away after one line', async () => {
    const board = new FakeBoard();
    const lines: string[] = [];
    const out = (l: string): void => {
      if (lines.length >= 1) throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      lines.push(l);
    };
    const r = await exec(['status', '--config', CONFIG], { board: () => board, out });
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(lines).toHaveLength(1);
  });
});

describe('service --print command path', () => {
  it('linux ExecStart starts with the absolute path of the running CLI', async () => {
    const r = await exec(['service', '--print', 'linux', '--config', CONFIG], { cliPath: '/opt/node/bin/mandrel-loop' });
    expect(r.out.join('\n')).toMatch(/^ExecStart=\/opt\/node\/bin\/mandrel-loop run --config /m);
  });

  it('defaults to the absolute path of process.argv[1]', async () => {
    const r = await exec(['service', '--print', 'linux', '--config', CONFIG]);
    const start = r.out.join('\n').match(/^ExecStart=(\S+) run /m)![1]!;
    expect(start.startsWith('/')).toBe(true);
  });
});

describe('once: a worker that cannot start', () => {
  it('prints the spawn error to the terminal, not only the board notes', async () => {
    const h = makeHarness(noopClaude);
    const cfgFile = join(h.root, 'mandrel-loop.config.json');
    writeFileSync(
      cfgFile,
      JSON.stringify({
        mandrel: { url: 'http://localhost:8080', project: 'p' },
        repos: { 'demo-repo': { path: h.repo, gate: 'true' } },
        models: { worker: 'w', critic: 'c' },
        workdir: join(h.root, 'work'),
      }),
    );
    const env = { ...h.env, MANDREL_TOKEN: 'x', ANTHROPIC_API_KEY: 'y', [PLAN_CONFIG.binEnv]: join(h.root, 'no-such-claude') };
    const auth = { uid: () => 1000, ghAuthOk: () => true, fileExists: () => true };
    const r = await exec(['once', '--config', cfgFile], { board: () => h.board, env, auth });
    expect(r.err.join('\n')).toMatch(/not started: could not run .*no-such-claude.*ENOENT/);
  });
});
