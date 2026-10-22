import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWorker } from '../src/worker.js';
import { makeHarness, TASK_ID } from './support/worker-harness.js';

describe('worker child environment', () => {
  it('carries only PATH, HOME, LANG and the credential the test set', async () => {
    const dump = (root: string): string => `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, 'env.json'))}, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));
fs.writeFileSync('w.txt', 'x');
execFileSync('git', ['add', '-A']);
execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'w']);
`;
    const h = makeHarness('', {}, {
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-placeholder',
      MANDREL_TOKEN: 'leak-1',
      MANDREL_AUTH_TOKEN: 'leak-2',
      GH_TOKEN: 'leak-3',
      GIT_DIR: '/nonexistent',
      SOME_OTHER: 'leak-4',
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(h.bin, 'claude'), dump(h.root));
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    expect(res?.outcome).toBe('built');
    const got = JSON.parse(readFileSync(join(h.root, 'env.json'), 'utf8')) as { env: Record<string, string>; argv: string[] };
    expect(Object.keys(got.env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'LANG', 'PATH']);
    expect(got.argv).toEqual(['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--model', 'w-model']);
  });
});
