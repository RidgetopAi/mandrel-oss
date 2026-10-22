import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv } from '../src/auth.js';
import { FakeBoard } from '../src/board/fake.js';
import { MandrelBoard, ToolError } from '../src/board/mandrel.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { boardFromConfig, run } from '../src/run.js';
import { FAKE_TOKEN, FAKE_URL, FakeMandrel } from './support/fake-mandrel-mcp.js';

const TOKEN = ['tok', 'fixture', '123'].join('-');
const ROOT = mkdtempSync(join(tmpdir(), 'loop-doctor-'));
const emptyHome = join(ROOT, 'home-empty');
mkdirSync(emptyHome);

function configFile(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(ROOT, 'cfg-'));
  const file = join(dir, 'mandrel-loop.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      mandrel: { url: FAKE_URL, project: 'p' },
      models: { worker: 'a', critic: 'b' },
      ...extra,
    }),
  );
  return file;
}

async function exec(
  cmd: 'doctor' | 'run',
  env: NodeJS.ProcessEnv,
  opts: { uid?: number; gh?: boolean; config?: string; board?: () => FakeBoard | MandrelBoard } = {},
) {
  const lines: string[] = [];
  const push = (l: string) => void lines.push(l);
  const code = await run([cmd, '--config', opts.config ?? configFile()], {
    out: push,
    err: push,
    env,
    ...(cmd === 'doctor' ? { board: opts.board ?? (() => new FakeBoard()) } : {}),
    auth: { uid: () => opts.uid ?? 1000, ghAuthOk: () => opts.gh ?? false },
  });
  return { code, output: lines.join('\n') };
}

const allSet = { HOME: emptyHome, MANDREL_TOKEN: TOKEN, CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: TOKEN, GH_TOKEN: TOKEN };

/** A board on `fake` built the way the CLI builds one, holding the fake's token (or `token`). */
const mcpBoard = (fake: FakeMandrel, token: string = FAKE_TOKEN) => () =>
  boardFromConfig({ mandrel: { url: FAKE_URL, project: 'p', tokenEnv: 'MANDREL_TOKEN', actor: 'a' } } as never, { ...allSet, MANDREL_TOKEN: token }, fake.fetch) as MandrelBoard;

describe('doctor auth', () => {
  it('exits 2 naming every missing credential, with an empty environment', async () => {
    const r = await exec('doctor', { HOME: emptyHome });
    expect(r.code).toBe(2);
    for (const n of ['MANDREL_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) expect(r.output).toContain(n);
  });

  it('never prints a credential value', async () => {
    for (const cmd of ['doctor', 'run'] as const) {
      for (const env of [allSet, { ...allSet, MANDREL_TOKEN: '' }]) {
        const r = await exec(cmd, env);
        expect(r.output).not.toContain(TOKEN);
      }
    }
    expect((await exec('doctor', allSet)).code).toBe(0);
  });

  it('accepts a Claude Code credentials file as the worker credential (existence only)', async () => {
    const home = join(ROOT, 'home-cred');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), 'secret-content');
    const r = await exec('doctor', { HOME: home, MANDREL_TOKEN: TOKEN, GH_TOKEN: TOKEN });
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('secret-content');
  });

  it('honours mandrel.tokenEnv', async () => {
    const config = configFile({ mandrel: { url: 'http://localhost:8080', project: 'p', tokenEnv: 'MY_TOKEN' } });
    const r = await exec('doctor', { ...allSet, MANDREL_TOKEN: undefined }, { config });
    expect(r.code).toBe(2);
    expect(r.output).toContain('MY_TOKEN');
  });

  it('requires gh credentials in pr mode only', async () => {
    const env = { ...allSet, GH_TOKEN: undefined };
    const pr = await exec('doctor', env, { gh: false });
    expect(pr.code).toBe(2);
    expect(pr.output).toContain('GH_TOKEN');
    expect((await exec('doctor', env, { gh: true })).code).toBe(0);
    expect((await exec('doctor', env, { gh: false, config: configFile({ merge: { mode: 'direct' } }) })).code).toBe(0);
  });
});

describe('root refusal', () => {
  it('refuses uid 0 for doctor and run unless worker.allowRoot', async () => {
    for (const cmd of ['doctor', 'run'] as const) {
      const r = await exec(cmd, allSet, { uid: 0 });
      expect(r.code).toBe(2);
      expect(r.output).toContain('worker.allowRoot');
    }
  });

  it('warns and continues when worker.allowRoot is true', async () => {
    const config = configFile({ worker: { allowRoot: true } });
    const d = await exec('doctor', allSet, { uid: 0, config });
    expect(d.code).toBe(0);
    expect(d.output).toMatch(/WARNING.*root/);
    const r = await exec('run', allSet, { uid: 0, config });
    expect(r.code).not.toBe(2);
    expect(r.output).toMatch(/WARNING.*root/);
  });
});

describe('childEnv', () => {
  it('passes only the allow-list', () => {
    const e = childEnv({ PATH: '/bin', HOME: '/h', LANG: 'C', ANTHROPIC_API_KEY: 'k', MANDREL_TOKEN: 'm', GH_TOKEN: 'g', FOO: 'x' });
    expect(Object.keys(e).sort()).toEqual(['ANTHROPIC_API_KEY', 'HOME', 'LANG', 'PATH']);
  });
});


describe('doctor live checks', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { PATH: process.env.PATH!, HOME: emptyHome } });

  function repo(name: string, identity = true): string {
    const dir = join(ROOT, name);
    mkdirSync(dir);
    sh(dir, 'init', '-q', '-b', 'main');
    if (identity) {
      sh(dir, 'config', 'user.email', 't@example.com');
      sh(dir, 'config', 'user.name', 'T');
    }
    writeFileSync(join(dir, 'f'), 'x');
    return dir;
  }

  /** A remote the repo can ls-remote: a second repo with one commit. */
  function withRemote(dir: string): string {
    const remote = repo(`${dir.split('/').pop()}-remote`);
    sh(remote, 'add', '-A');
    sh(remote, '-c', 'user.email=a@b.c', '-c', 'user.name=A', 'commit', '-q', '-m', 'i');
    sh(dir, 'remote', 'add', 'origin', remote);
    return dir;
  }

  const cfg = (path: string) => configFile({ repos: { 'repo:r': { path, gate: 'true' } } });
  const gitPath = (script: string): NodeJS.ProcessEnv => {
    const bin = mkdtempSync(join(ROOT, 'bin-'));
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), script.replace('REAL', real));
    chmodSync(join(bin, 'git'), 0o755);
    return { ...allSet, PATH: `${bin}:${process.env.PATH}` };
  };

  it('exits 0 when every live check is healthy', async () => {
    const r = await exec('doctor', allSet, { config: cfg(withRemote(repo('ok'))) });
    expect(r.output).toContain('all checks passed');
    expect(r.code).toBe(0);
  });

  it('exits 2 naming mandrel-ping when the Mandrel URL refuses connections', async () => {
    const refuse = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;
    const config = configFile();
    const r = await exec('doctor', allSet, {
      config,
      board: () =>
        boardFromConfig({ mandrel: { url: 'http://127.0.0.1:1', project: 'p', tokenEnv: 'MANDREL_TOKEN', actor: 'a' } } as never, allSet, refuse) as MandrelBoard,
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain('mandrel-ping');
  });

  it('exits 2 naming mandrel-project when the project is not found', async () => {
    const board = new FakeBoard();
    board.listStage = async () => {
      throw new ToolError('task.list', 'project not found: p');
    };
    const r = await exec('doctor', allSet, { board: () => board });
    expect(r.code).toBe(2);
    expect(r.output).toContain('mandrel-project');
  });

  it('reaches the project check when Mandrel answers but the project does not exist, and names the projects that do', async () => {
    const fake = new FakeMandrel({
      handle: (c) =>
        c.tool === 'project' && c.headers.get('X-Mandrel-Project') === null
          ? { structuredContent: { results: [{ id: '1', name: 'other' }] } }
          : { isError: true, text: "[PROJECT_BINDING_UNRESOLVED] Configured project binding 'p' does not match any project." },
    });
    const r = await exec('doctor', allSet, { board: mcpBoard(fake) });
    expect(r.code).toBe(2);
    expect(r.output).not.toContain('check mandrel-ping failed');
    expect(r.output).toMatch(/check mandrel-project failed.*PROJECT_BINDING_UNRESOLVED.*this token sees: other.*project\(\{action:'create'\}\)/);
    expect(fake.calls.find((c) => c.tool === 'project')?.headers.get('X-Mandrel-Project')).toBeNull();
  });

  it('exits 2 naming mandrel-auth, with where to get a token, when the server refuses the token', async () => {
    const fake = new FakeMandrel({ token: 'the-server-token' });
    const r = await exec('doctor', allSet, { board: mcpBoard(fake) });
    expect(r.code).toBe(2);
    expect(r.output).toContain('check mandrel-auth failed');
    expect(r.output).toContain(`${FAKE_URL}/mcp refused the token in MANDREL_TOKEN (`);
    expect(r.output).toContain('Settings → API tokens');
    expect(r.output).toContain('MCP_AUTH_TOKEN');
    expect(r.output).not.toContain('check mandrel-ping failed');
    expect(r.output).not.toContain(TOKEN);
    expect(r.output).not.toContain(FAKE_TOKEN);
  });

  it('exits 2 naming mandrel-endpoint when the URL answers 405 (no /mcp there)', async () => {
    const fake = new FakeMandrel({ intercept: () => new Response('<html>405 Not Allowed</html>', { status: 405 }) });
    const r = await exec('doctor', allSet, { board: mcpBoard(fake) });
    expect(r.code).toBe(2);
    expect(r.output).toContain(`check mandrel-endpoint failed: task.list: HTTP 405: no MCP endpoint at ${FAKE_URL}/mcp`);
    expect(r.output).toContain('base URL');
  });

  it('passes on a legacy-surface server: gateway calls dispatch though tools/list names only flat tools', async () => {
    const fake = new FakeMandrel({
      tools: ['context_store', 'task_list', 'project_list'],
      handle: (c) => ({ structuredContent: c.args.action === 'claim' ? { claimed: false, reason: 'not-found' } : { results: [] } }),
    });
    const r = await exec('doctor', allSet, { board: mcpBoard(fake) });
    expect(r.output).toContain('all checks passed');
    expect(r.code).toBe(0);
  });

  it('names an upgrade when the server does not know the gateway tool', async () => {
    const fake = new FakeMandrel({
      handle: (c) => {
        throw new McpError(ErrorCode.InvalidParams, `Input validation failed: No validation schema found for tool: ${c.tool}`);
      },
    });
    const r = await exec('doctor', allSet, { board: mcpBoard(fake) });
    expect(r.code).toBe(2);
    expect(r.output).toMatch(/check mandrel-project failed: .* does not know the gateway tool .*fix: upgrade Mandrel/);
  });

  it('passes the Mandrel checks against a healthy MCP server and ends its session', async () => {
    const fake = new FakeMandrel({ handle: (c) => ({ structuredContent: c.args.action === 'claim' ? { claimed: false, reason: 'not-found' } : { results: [] } }) });
    const r = await exec('doctor', allSet, { board: mcpBoard(fake) });
    expect(r.output).toContain('all checks passed');
    expect(r.code).toBe(0);
    expect(fake.sessions.size).toBe(0);
  });

  it('exits 2 naming repo-path when the repo path is missing', async () => {
    const r = await exec('doctor', allSet, { config: cfg(join(ROOT, 'nope')) });
    expect(r.code).toBe(2);
    expect(r.output).toContain('repo-path');
  });

  it('exits 2 naming repo-git when the repo path is not a git repo', async () => {
    const dir = join(ROOT, 'plain');
    mkdirSync(dir);
    const r = await exec('doctor', allSet, { config: cfg(dir) });
    expect(r.code).toBe(2);
    expect(r.output).toContain('repo-git');
  });

  it('exits 2 naming git-ls-remote when git ls-remote exits 128', async () => {
    const env = gitPath('#!/bin/sh\n[ "$1" = ls-remote ] && { echo "fatal: could not read Username" >&2; exit 128; }\nexec REAL "$@"\n');
    const r = await exec('doctor', env, { config: cfg(withRemote(repo('lsr'))) });
    expect(r.code).toBe(2);
    expect(r.output).toContain('git-ls-remote');
  });

  it('exits 2 naming git-identity when git has no user.email', async () => {
    const r = await exec('doctor', allSet, { config: cfg(withRemote(repo('noid', false))) });
    expect(r.code).toBe(2);
    expect(r.output).toContain('git-identity');
    expect(r.output).toContain('user.email');
  });
});

describe('doctor task-claims check', () => {
  /** A fake Mandrel; `claimsEnabled` mirrors the server's MANDREL_TASK_CLAIM_ENABLED. */
  function claimServer(claimsEnabled: boolean) {
    const held = new Set<string>();
    const claimCalls: unknown[] = [];
    const fake = new FakeMandrel({
      handle: (c) => {
        if (c.args.action !== 'claim') return { structuredContent: { results: [] } };
        claimCalls.push(c.args);
        return {
          structuredContent: claimsEnabled
            ? { claimed: false, reason: 'not-found' }
            : { claimed: false, reason: 'disabled', message: 'Task claiming is disabled in this environment' },
        };
      },
    });
    return { fetchFn: fake.fetch, held, claimCalls };
  }
  const boardOn = (fetchFn: typeof fetch) => () =>
    boardFromConfig({ mandrel: { url: FAKE_URL, project: 'p', tokenEnv: 'MANDREL_TOKEN', actor: 'a' } } as never, { ...allSet, MANDREL_TOKEN: FAKE_TOKEN }, fetchFn) as MandrelBoard;

  it('exits nonzero naming MANDREL_TASK_CLAIM_ENABLED when the server has claims disabled', async () => {
    const s = claimServer(false);
    const r = await exec('doctor', allSet, { board: boardOn(s.fetchFn) });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('check task-claims failed');
    expect(r.output).toContain('MANDREL_TASK_CLAIM_ENABLED');
  });

  it('passes the claims check when claims are enabled, and leaves no claim held', async () => {
    const s = claimServer(true);
    const r = await exec('doctor', allSet, { board: boardOn(s.fetchFn) });
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('task-claims');
    expect(s.claimCalls).toHaveLength(1);
    expect(s.held.size).toBe(0);
  });

  it('never claims a real task: the probe targets an id that exists nowhere', async () => {
    const s = claimServer(true);
    await exec('doctor', allSet, { board: boardOn(s.fetchFn) });
    expect(s.claimCalls).toEqual([{ action: 'claim', taskId: '00000000-0000-0000-0000-000000000000' }]);
  });
});
