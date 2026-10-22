/**
 * The `mandrel-loop` that scripts/test/loop-readme-doctest.test.sh puts on PATH: the real CLI
 * (src/run.ts) wired to an empty FakeBoard instead of a Mandrel server. Not a vitest file.
 * The root refusal is bypassed by reporting a non-root uid so the doctest also passes in a container
 * that runs as root; every other `doctor` check (token, worker credential, gh) is the real one.
 */
import { FakeBoard } from '../../src/board/fake.js';
import { run } from '../../src/run.js';

const NON_ROOT_UID = 1000;

process.exitCode = await run(process.argv.slice(2), {
  board: () => new FakeBoard(),
  auth: { uid: () => NON_ROOT_UID },
});
