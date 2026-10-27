/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * THE ONE DIRECTORY VITE LOADS `.env*` FILES FROM.
 *
 * Pinned away from the project root ON PURPOSE. The on-host deploy paths
 * (the prod build; formerly also a fast UI deploy script, deleted by
 * an earlier task — prod is containerized) run `npm run build`
 * in this directory, where Vite's default env loading picked up the untracked
 * legacy `frontend/.env.production.local` at highest precedence — and a single
 * dynamic env read then inlined that whole file into the shipped bundle
 * (VITE_MCP_BASE_URL, a var with NO reader in src, was measured in prod's
 * built assets). The Docker path was protected by .dockerignore; this pin
 * protects EVERY path, present and future, at the loader itself: a root-level
 * `.env*` file simply does not exist as far as Vite is concerned.
 *
 * Real env files (rarely needed — the app is same-origin by default) go in
 * `env/`, next to `env/.env.example`. Resolved from this config file's own
 * location, not process.cwd(), so an out-of-dir invocation cannot re-open the
 * root-level hole.
 */
const ENV_DIR = fileURLToPath(new URL('./env', import.meta.url));

/**
 * Vite build shell for Mandrel Command (P0.1 — replaces CRA/react-scripts).
 *
 * Config-driven (no hardcoded tunables — configs-not-hardcoded rule): the dev
 * server port, the `/api` proxy target, and the preview port are all read from
 * env with the historical CRA defaults as fallbacks. Override in a `.env` /
 * `.env.local` (these are Vite-side, NOT client-exposed — they are read here in
 * Node at config time and are deliberately NOT `VITE_`-prefixed so they never
 * leak into the client bundle).
 *
 * Output dir is `build/` (NOT Vite's default `dist/`) so the existing deploy
 * path keeps working unchanged: frontend/Dockerfile does
 * `COPY --from=builder /app/frontend/build /usr/share/nginx/html` and
 * frontend/nginx.conf serves that dir. See frontend/DEPLOY-NOTES.md.
 */
/**
 * The timezone every test runs in. See the long note on `test.env.TZ` below for WHY it is
 * pinned and why it is not UTC. It is exported so a runner can be told, rather than each
 * place restating the string (configs-not-hardcoded).
 */
export const TEST_TIMEZONE = 'America/New_York';

export default defineConfig(({ mode }) => {
  if (mode === 'test') {
    // FORCE it, before vitest forks its workers, so the children inherit it. Setting it
    // via `test.env` alone is NOT enough: measured 2026-08-08, `test.env` only FILLS IN a
    // missing var — an ambient `TZ=UTC` (which is what a CI container normally exports)
    // wins over it, and the suite then runs in the one zone where the date-only trap is
    // undetectable. Node freezes the zone per process, so this is the last moment it can
    // be set at all.
    process.env.TZ = TEST_TIMEZONE;
  }
  // Load ALL env (empty prefix) so we can read the non-VITE_ dev-tooling knobs.
  // Same pinned ENV_DIR as the client-exposed env below — ONE loading surface.
  const env = loadEnv(mode, ENV_DIR, '');

  const devPort = Number(env.DEV_SERVER_PORT ?? 3000);
  const previewPort = Number(env.PREVIEW_SERVER_PORT ?? 4173);
  // Matches today's CRA `proxy` field target (package.json "proxy").
  const apiProxyTarget = env.DEV_API_PROXY_TARGET ?? 'http://localhost:5000';

  return {
    // See ENV_DIR above: env files load ONLY from `env/`, never the project root.
    envDir: ENV_DIR,

    plugins: [react()],

    // Third-party libs (e.g. plotly.js) reference the Node `global`; CRA/webpack
    // shimmed it, Vite does not. Alias it to `globalThis` for browser runtime.
    define: {
      global: 'globalThis',
    },

    server: {
      port: devPort,
      // Fail loudly if the port is taken rather than silently hopping ports
      // (keeps the proxy contract + any tooling that assumes the port honest).
      strictPort: false,
      proxy: {
        // Dev-only: forward the UI's REST calls to the Command backend, exactly
        // like the old CRA `"proxy": "http://localhost:5000"` did.
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },

    preview: {
      port: previewPort,
    },

    build: {
      // Keep the historical CRA output dir so the Dockerfile/nginx path is
      // unchanged at cutover.
      outDir: 'build',
      // A past incident said ship source maps for real file/line prod stack traces. RESCOPED
      // 2026-09-17: measured, in ONE session, three
      // sourcemap variants under an identical memory-capped cgroup —
      //   true     -> peak 4.334 GiB, FAILS at node's default heap (rc=134, JS heap OOM)
      //   'hidden' -> peak 4.316 GiB, FAILS at default heap — true's memory twin, not a
      //               middle ground: same 59 maps generated, only the comment differs
      //   false    -> peak 3.042 GiB, SUCCEEDS at default heap, 0 maps
      // The cost is in map GENERATION, not emission, so 'hidden' buys nothing here. The operator's
      // ruling: go to false. Traded knowingly — an internal-only command UI, source held
      // in-repo, is worth more as 1.3 GiB of lane headroom than as symbolicated prod traces.
      sourcemap: false,
    },

    test: {
      globals: true,
      environment: 'jsdom',
      /**
       * THE TEST RUNTIME'S TIMEZONE IS PINNED, AND IT IS PINNED TO A NEGATIVE-OFFSET ONE
       *.
       *
       * Two reasons, and the second is why it is not UTC:
       *
       *  1. DETERMINISM. Node resolves the process timezone once and FREEZES it for the
       *     worker — `process.env.TZ = …` inside a test is a silent no-op (measured: a
       *     probe reassigning it four times reported the same zone every time). So a date
       *     assertion's meaning is decided entirely by the box, and "green here" would not
       *     be green in a UTC CI runner.
       *
       *  2. SENSITIVITY. The date-only trap — a `YYYY-MM-DD` or a Postgres DATE, both of
       *     which parse as MIDNIGHT UTC, read through local calendar fields and landing on
       *     the PREVIOUS day — is INVISIBLE under TZ=UTC. A guard for it that runs at UTC
       *     passes whether or not the bug is present. America/New_York is UTC-4/-5, which
       *     is where the whole userbase reads this UI, and it is the only setting in which
       *     `src/utils/datetime.test.ts` can actually fail.
       *
       * Verified safe before pinning: the full suite was run under TZ=UTC and every one of
       * the 118 pre-existing test files passed, so nothing else here depends on the zone.
       */
      env: { TZ: TEST_TIMEZONE },
      setupFiles: ['./src/setupTests.ts'],
      // Mirror the source layout; only *.test.ts(x) are tests.
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});
