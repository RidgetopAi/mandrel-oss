import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergerOptions, sweep } from '../src/merger.js';
import { boardWith, evidenceTask, git, makeRepo, script } from './merger-helpers.js';

/** A recording gh: appends one JSON line of argv per call; answers by subcommand. */
function fakeGh(dir: string, viewState: string): { bin: string; calls: () => string[][] } {
  const log = join(dir, 'gh.log');
  const bin = script(
    dir,
    'gh',
    `node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))+"\\n")' "${log}" "$@"
if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/42"; fi
if [ "$1 $2" = "pr view" ]; then echo '{"state":"${viewState}"}'; fi`,
  );
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) };
}

describe('merger pr mode', () => {
  it('opens a PR carrying the verdict, then marks merged once gh says MERGED', async () => {
    const repo = makeRepo();
    const task = evidenceTask(repo.branchSha);
    const board = boardWith(task);
    const open = fakeGh(repo.root, 'OPEN');
    const r1 = await sweep(board, mergerOptions(repo.work, { ghBin: open.bin }));
    expect(r1).toEqual([{ id: task.id, action: 'pr-opened', detail: 'https://github.com/o/r/pull/42' }]);

    const create = open.calls().find((c) => c[0] === 'pr' && c[1] === 'create')!;
    expect(create).toContain('--base');
    expect(create[create.indexOf('--base') + 1]).toBe('main');
    expect(create[create.indexOf('--head') + 1]).toBe('feat');
    const body = create[create.indexOf('--body') + 1]!;
    expect(body).toContain('clause one holds');
    expect(body).toContain('clause two holds');
    expect(git(repo.origin, 'rev-parse', 'refs/heads/feat')).toBe(repo.branchSha);

    const after = (await board.get(task.id))!;
    expect(after.stage).toBe('evidence');
    expect(after.metadata.punch?.pr).toEqual({ url: 'https://github.com/o/r/pull/42', number: 42 });

    const still = await sweep(board, mergerOptions(repo.work, { ghBin: open.bin }));
    expect(still[0]?.action).toBe('pr-pending');
    expect((await board.get(task.id))!.stage).toBe('evidence');

    const merged = fakeGh(repo.root, 'MERGED');
    const r2 = await sweep(board, mergerOptions(repo.work, { ghBin: merged.bin }));
    expect(r2[0]?.action).toBe('pr-merged');
    expect(merged.calls().some((c) => c.join(' ') === 'pr view 42 --json state')).toBe(true);
    expect((await board.get(task.id))!.stage).toBe('merged');
  });

  it.each([
    ['verdict not PASS', { verdict: { result: 'FAIL', sha: 'x' } }, {}],
    ['proofKind look', { proofKind: 'look' }, {}],
    ['risk:gate tag', {}, { tags: ['risk:gate'] }],
  ])('does not open a PR when %s', async (_n, punch, over) => {
    const repo = makeRepo();
    const task = evidenceTask(repo.branchSha, over, punch);
    const board = boardWith(task);
    const gh = fakeGh(repo.root, 'OPEN');
    expect(await sweep(board, mergerOptions(repo.work, { ghBin: gh.bin }))).toEqual([]);
    expect((await board.get(task.id))!.stage).toBe('evidence');
  });

  it('sends the punch back to verifying when the branch moved past the verdict sha', async () => {
    const repo = makeRepo();
    const task = evidenceTask('0'.repeat(40));
    const board = boardWith(task);
    const gh = fakeGh(repo.root, 'OPEN');
    const r = await sweep(board, mergerOptions(repo.work, { ghBin: gh.bin }));
    expect(r[0]?.action).toBe('restaged-stale');
    expect((await board.get(task.id))!.stage).toBe('verifying');
  });
});
