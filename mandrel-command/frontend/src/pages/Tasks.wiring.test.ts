/**
 * Tasks rebuild pattern guard (P2 — follows the Contexts/Sessions screen-rebuild
 * pattern). Asserts the rebuilt Tasks page + its `tasks/` module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated);
 *   3. surface the TYPED build-story box from real graph edges — NOT the task
 *      `dependencies` array and NOT any semantic `related` list (data-gap policy
 *      10397f65: never conflate structure with either);
 *   4. carry no hardcoded hex colours in the stylesheet (token-driven).
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'tasks');

const pageSrc = readFileSync(resolve(here, 'Tasks.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Tasks.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('Tasks rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Tasks rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.tasks\./);
  });

  it('no part imports axios or the generated service clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/api['"]/);
      expect(src).not.toMatch(/apiService/);
    }
  });
});

describe('Tasks rebuild — typed build-story box, not dependencies/related (the moat)', () => {
  it('the build story reads api.tasks.links (typed edges), never dependencies or related', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/api\.tasks\.links\(/);
    // The typed build-story box must not be fed by the task `dependencies` array or a
    // semantic `related` list.
    expect(hooks).not.toMatch(/api\.tasks\.dependencies\(/);
    expect(hooks).not.toMatch(/api\.tasks\.related\(/);

    // The build-story renders the typed TaskLink edges — never a dependencies/related prop.
    // (Extracted from the old ThreadDetail into BuildStory.tsx and reused inside the CRUD
    // drawer when a task is selected — the moat moved, it was not lost.)
    const story = readFileSync(resolve(modDir, 'BuildStory.tsx'), 'utf8');
    expect(story).toMatch(/TaskLink/);
    expect(story).toMatch(/edgeLabel\(/);
    expect(story).toMatch(/links/);
    expect(story).not.toMatch(/\.dependencies\b/);
    expect(story).not.toMatch(/dependencies:/);
    expect(story).not.toMatch(/\.related\b/);
  });
});

describe('Tasks rebuild — real status enum (grounded, not the stale generated model)', () => {
  it('config maps the real backend statuses (todo/in_progress/blocked/completed), not pending', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/'todo'/);
    expect(config).toMatch(/'in_progress'/);
    expect(config).toMatch(/'blocked'/);
    expect(config).toMatch(/'completed'/);
    // 'pending' is the stale generated enum the DB never stores — must not drive columns.
    expect(config).not.toMatch(/'pending'/);
  });
});

describe('Tasks rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Tasks.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});
