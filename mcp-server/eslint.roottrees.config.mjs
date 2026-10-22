// ESLint v9 flat config for the REPO-ROOT `scripts/` and `evals/` trees.
//
// ★ WHY THIS FILE IS NAMED `eslint.roottrees.config.mjs` AND LIVES IN mcp-server/,
//   NOT `eslint.config.mjs` AT THE REPO ROOT. It was at the repo root for exactly
//   one commit and turned the authoritative gate RED (STAGE L, exit code 2 — a
//   fatal usage error, not "lint found problems") in mandrel-command/backend and
//   mandrel-command/frontend, two workspaces this task never edited.
//
//   MECHANISM, reproduced on demand rather than reasoned about. Those workspaces
//   run eslint ^8 with .eslintrc files and lint via `eslint src --ext .ts`.
//   ESLint 8 walks UP from its working directory looking for a flat config, and
//   its lookup list (verified in eslint/lib source) is exactly:
//       eslint.config.js | eslint.config.mjs | eslint.config.cjs
//   Finding ANY of those at ANY ancestor flips it into flat-config mode, where
//   `--ext` was removed and is a fatal CLI error. So a file at the repo root
//   silently changed the behaviour of sibling workspaces several levels down.
//
//   THE `ignores` BLOCK BELOW CANNOT PREVENT THIS. The failure happens at CLI
//   option validation, BEFORE any config content is consulted — the minimal
//   reproduction triggers it with `export default []`, a config that matches and
//   ignores nothing. Scoping the CONTENT was never going to help; only keeping
//   the FILENAME out of the ancestor lookup does.
//
//   Hence: a name that is in NEITHER eslint 8's nor eslint 9's lookup list, in a
//   directory that is not an ancestor of any other workspace, loaded explicitly
//   with `--config` (which makes eslint's base path the CURRENT WORKING
//   DIRECTORY, so the repo-root trees are still reachable). Frozen reproduction
//   of the regression: reports/artifacts/59b8333e-tsconfig-scripts-evals/
//   eslint-mode-flip-repro.sh in the riverbend repo.
//
// WHY THIS FILE EXISTS. ESLint's base path is the directory holding the config
// file when the config is DISCOVERED, and the working directory when it is passed
// with --config (measured both ways). Files outside the base path are ignored. mcp-server/eslint.config.js therefore
// CANNOT reach ../scripts or ../evals: asking it to lint them produced
// `File ignored because outside of base path`, i.e. a silent zero. The root trees
// were linted by nothing for a structural reason, not a rule.
//
// WHY IT RE-EXPORTS RATHER THAN RESTATES. The rules are DERIVED from
// mcp-server/eslint.config.js, never hand-copied — same reason that file derives
// its own test-block selectors from SRC_RULES: a second copy of a ruleset is a
// copy that drifts, and a drifted lint config fails OPEN. Tighten the rules there
// and the root trees tighten with them, automatically.
//
// The import is a RELATIVE PATH on purpose. The repo root has no node_modules
// (`node -e "require.resolve('globals')"` throws here), so a config that imported
// 'globals' or '@typescript-eslint/parser' directly could not load. Importing the
// mcp-server config by path makes Node resolve ITS bare specifiers from
// mcp-server/node_modules, where they actually exist.
import base from './eslint.config.js';

export default [
  {
    // Everything that owns its own lint config, or is not ours to lint. Narrow on
    // purpose: this config governs the two root trees and nothing else.
    ignores: [
      'mcp-server/**',
      'mandrel-command/**',
      'adapters/**',
      'node_modules/**',
      '**/node_modules/**',
      'dist/**',
      '**/*.d.ts',
    ],
  },
  ...base,
];
