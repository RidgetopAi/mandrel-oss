/**
 * The launch preflight that disarms a stale dist/.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * package.json declares `"start": "node dist/server.js"`. dist/ is gitignored, so it is
 * untracked box state that no deploy path refreshes: an image-based deploy never runs
 * `npm run build` on a host, so `npm start` there silently serves a stale dist/.
 *
 * scripts/preflight-dist.cjs turns that silent success into a loud refusal. It is a
 * GUARD, so it is tested by mutation: each case builds a real backend-shaped tree,
 * runs the SHIPPED script in it as a child process, and asserts the exit code. The
 * GREEN control (a freshly built tree) runs in every case's setup, so a guard that
 * refused everything would fail here just as loudly as one that refused nothing.
 *
 * POPULATION: this suite covers the preflight's own decision table plus the two
 * wirings that make it reachable — package.json "start" and the Dockerfile runner
 * stage. It does NOT cover `node dist/server.js` invoked directly, which bypasses
 * npm entirely and is out of this guard's reach by construction.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const REAL_SCRIPTS = path.join(BACKEND_DIR, 'scripts');

/** Build a self-contained backend-shaped tree carrying real copies of both scripts. */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'distpreflight-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const f of ['preflight-dist.cjs', 'dist-manifest.cjs']) {
    fs.copyFileSync(path.join(REAL_SCRIPTS, f), path.join(root, 'scripts', f));
  }
  fs.mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'server.ts'), 'export const start = () => {};\n');
  fs.writeFileSync(path.join(root, 'src', 'routes', 'health.ts'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"outDir":"./dist"}}\n');
  return root;
}

/** Stand in for `tsc`: emit dist/server.js, then write the manifest with the real writer. */
function build(root: string): void {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'server.js'), 'module.exports = {};\n');
  const rc = spawnSync(process.execPath, [path.join(root, 'scripts', 'dist-manifest.cjs')], {
    encoding: 'utf8',
  });
  expect(rc.status).toBe(0);
}

function preflight(root: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'preflight-dist.cjs')], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('dist/ launch preflight', () => {
  const trees: string[] = [];
  const tree = (): string => {
    const t = makeTree();
    trees.push(t);
    return t;
  };

  afterAll(() => {
    for (const t of trees) fs.rmSync(t, { recursive: true, force: true });
  });

  it('PASSES a freshly built tree (the GREEN control every other case depends on)', () => {
    const root = tree();
    build(root);
    const r = preflight(root);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dist/ verified against');
  });

  it('REFUSES when a source file changed after the build — the prod host case', () => {
    const root = tree();
    build(root);
    expect(preflight(root).status).toBe(0); // control: green before the mutation

    fs.writeFileSync(path.join(root, 'src', 'routes', 'health.ts'), 'export const ok = false;\n');

    const r = preflight(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REFUSING TO START');
    expect(r.stderr).toContain('STALE');
    expect(r.stderr).toContain('npm run build');
  });

  it('REFUSES when a source file was ADDED after the build', () => {
    const root = tree();
    build(root);
    fs.writeFileSync(path.join(root, 'src', 'routes', 'new.ts'), 'export const n = 1;\n');
    expect(preflight(root).status).toBe(1);
  });

  it('REFUSES when a source file was DELETED after the build', () => {
    const root = tree();
    build(root);
    fs.rmSync(path.join(root, 'src', 'routes', 'health.ts'));
    expect(preflight(root).status).toBe(1);
  });

  it('REFUSES when tsconfig.json changed — compiler inputs are hashed too', () => {
    const root = tree();
    build(root);
    fs.writeFileSync(
      path.join(root, 'tsconfig.json'),
      '{"compilerOptions":{"outDir":"./dist","target":"ES5"}}\n'
    );
    expect(preflight(root).status).toBe(1);
  });

  it('REFUSES when dist/server.js is absent', () => {
    const root = tree();
    build(root);
    fs.rmSync(path.join(root, 'dist', 'server.js'));
    const r = preflight(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dist/server.js does not exist');
  });

  it('REFUSES a dist/ with no manifest — a build of unknown provenance', () => {
    const root = tree();
    build(root);
    fs.rmSync(path.join(root, 'dist', '.build-manifest.json'));
    const r = preflight(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no usable build manifest');
  });

  it('REFUSES an unreadable manifest — could-not-measure is not a pass', () => {
    const root = tree();
    build(root);
    fs.writeFileSync(path.join(root, 'dist', '.build-manifest.json'), '{ this is not json');
    expect(preflight(root).status).toBe(1);
  });

  it('REFUSES a manifest whose shape it does not recognise', () => {
    const root = tree();
    build(root);
    fs.writeFileSync(path.join(root, 'dist', '.build-manifest.json'), '{"srcHash":"deadbeef"}');
    expect(preflight(root).status).toBe(1);
  });

  it('PASSES a sourceless runtime — the runner image ships dist/ and no src/', () => {
    const root = tree();
    build(root);
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.rmSync(path.join(root, 'tsconfig.json'));
    const r = preflight(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sourceless runtime');
  });

  it('REFUSES a half-missing source tree — that is not an image, it is a mangled checkout', () => {
    const root = tree();
    build(root);
    fs.rmSync(path.join(root, 'src'), { recursive: true }); // tsconfig.json left behind
    const r = preflight(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('partially missing');
  });

  it('REFUSES a sourceless runtime that also lost its manifest', () => {
    const root = tree();
    build(root);
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.rmSync(path.join(root, 'tsconfig.json'));
    fs.rmSync(path.join(root, 'dist', '.build-manifest.json'));
    expect(preflight(root).status).toBe(1);
  });
});

describe('the preflight is WIRED — a guard nothing invokes guards nothing', () => {
  it('package.json "start" runs the preflight before node dist/server.js', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string>; main?: string };

    // Inline `&&`, not a `prestart` hook: `npm start --ignore-scripts` skips hooks.
    expect(pkg.scripts.start).toBe('node scripts/preflight-dist.cjs && node dist/server.js');

    // `build` must write the manifest, or every build produces a dist the guard refuses.
    expect(pkg.scripts.build).toContain('scripts/dist-manifest.cjs');

    // No `"main": "dist/server.js"`: nothing imports this package, and the field was a
    // second, unguarded pointer at the same stale artifact.
    expect(pkg.main).toBeUndefined();
  });

  it('the Dockerfile runner stage copies both scripts, or `npm start` cannot resolve them', () => {
    const df = fs.readFileSync(path.join(BACKEND_DIR, 'Dockerfile'), 'utf8');
    const runner = df.slice(df.indexOf('AS runner'));
    expect(runner).not.toBe('');

    const copiesScripts = runner
      .split('\n')
      .filter((l) => l.startsWith('COPY') && l.includes('./backend/scripts/'));
    expect(copiesScripts).toHaveLength(1);
    expect(copiesScripts[0]).toContain('preflight-dist.cjs');
    expect(copiesScripts[0]).toContain('dist-manifest.cjs');
  });
});
