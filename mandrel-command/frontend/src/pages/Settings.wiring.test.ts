/**
 * Settings rebuild pattern guard (P4 — follows the Decisions/Contexts screen-rebuild
 * pattern). Asserts the rebuilt Settings page + its `settings/` module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire every WRITE through the UNIFIED `api.*` client (not axios / generated / raw fetch);
 *   3. carry no hardcoded hex colours in the stylesheet (token-driven);
 *   4. keep tunables in config.ts (configs-not-hardcoded) — the section rail lives there;
 *   5. honour the data-gap policy (10397f65) — the honest-empty sections name their gap.
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'settings');

const pageSrc = readFileSync(resolve(here, 'Settings.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Settings.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
// Token-purity guard: the stylesheet must carry NO raw colour or font-size literals —
// every value comes from a design token (var(--x)). Pins the full stated invariant.
const RAW_COLOUR = /\b(?:rgb|rgba|hsl|hsla)\(/g;
const PX_FONT_SIZE = /font-size:\s*\d+px/g;

describe('Settings rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Settings rebuild — unified client only (no axios / generated / raw fetch)', () => {
  it('hooks read/write through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.users\./);
    expect(hooks).toMatch(/api\.projects\./);
  });

  it('no part imports axios, a legacy client, or hand-rolls fetch()', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/api['"]/);
      // The legacy Settings page hand-rolled fetch(`${apiBaseUrl}/users/...`); the rebuild
      // must route every write through the typed client instead.
      expect(src).not.toMatch(/\bfetch\s*\(\s*`\$\{apiBaseUrl\}/);
    }
  });
});

describe('Settings rebuild — every live write maps to a real backend route', () => {
  it('the hooks reference the real users + projects endpoints', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    for (const call of [
      'api.users.updateProfile',
      'api.users.changePassword',
      'api.users.updatePreferences',
      'api.users.revokeSessions',
      'api.projects.remove',
    ]) {
      expect(hooks).toContain(call);
    }
  });

  /**
   * The INSTANCE-WIDE default-project writes must not come back (epic 41293984 §A).
   * `set-primary` / `clear-primary` set `projects.metadata.is_primary`, a flag on the
   * SHARED projects table: one user setting "their" default set it for every user, and
   * `clearPrimary`'s UPDATE carries no user scoping whatsoever. The default project is
   * now per-user (`PATCH /api/users/preferences`).
   *
   * Asserted as an ABSENCE, in the settings module only — the endpoints still exist and
   * still have legitimate non-UI consumers (mcp-server bootstrap), so this is scoped to
   * "the Settings screen does not write them", not "nobody may".
   */
  it('the Settings screen never writes the INSTANCE-WIDE primary-project flag', () => {
    for (const { f, src } of allTsSrcs.concat([
      { f: 'hooks.ts', src: readFileSync(resolve(modDir, 'hooks.ts'), 'utf8') },
    ])) {
      expect({ f, hit: /api\.projects\.setPrimary/.test(src) }).toEqual({ f, hit: false });
      expect({ f, hit: /api\.projects\.clearPrimary/.test(src) }).toEqual({ f, hit: false });
    }
  });

  it('the default-project control writes the PER-USER preference', () => {
    const src = readFileSync(resolve(modDir, 'ProjectsSection.tsx'), 'utf8');
    // Through SettingsContext, which is the ONE writer of this preference.
    expect(src).toMatch(/setDefaultProjectId/);
    // …and it stores an ID, not a name — the rename bug closed by construction.
    expect(src).toMatch(/defaultProjectId/);
  });
});

describe('Settings rebuild — tunables live in config (configs-not-hardcoded)', () => {
  it('the section rail + gap copy are defined in config.ts', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/SETTINGS_SECTIONS/);
    expect(config).toMatch(/DATA_GAPS/);
  });
});

describe('Settings rebuild — honest data-gap sections name the gap', () => {
  it.each(['IdentitySection.tsx', 'NotificationsSection.tsx', 'ApiTokensSection.tsx'])(
    '%s renders a DATA_GAPS note and never fakes a live write',
    (file) => {
      const src = readFileSync(resolve(modDir, file), 'utf8');
      expect(src).toMatch(/DATA_GAPS\./);
      // A not-yet-available section must not call a mutation hook.
      expect(src).not.toMatch(/\.mutate\(/);
    },
  );
});

describe('Settings rebuild — token-driven', () => {
  it('the stylesheet carries no hardcoded colour or font-size literals (tokens only)', () => {
    const css = readFileSync(resolve(modDir, 'Settings.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
    expect(css.match(RAW_COLOUR) ?? []).toEqual([]);
    expect(css.match(PX_FONT_SIZE) ?? []).toEqual([]);
  });
});
