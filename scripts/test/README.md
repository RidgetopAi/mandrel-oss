# Shell tests — authoring rules

Every `scripts/test/*.test.sh` is run by `bash scripts/oss-gate.sh` (stage H) as
`bash <file>`; a non-zero exit is RED. Nothing needs wiring: a new file is enforced the
moment it lands. `bash scripts/oss-gate.sh --shell-tests-only` runs this stage alone.

## Rules

1. **Independent of the invoking environment.** Stage H runs each test under `env -i`
   with a throwaway, empty `HOME`, a fresh `TMPDIR`, `CI=true`, and a placeholder
   database on a closed port. A test must pass in exactly that shape: it may not read
   `~/.gitconfig`, rely on a git identity, or on any variable the caller exported.
   Tests that run `git commit` set `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (or `-c user.*`)
   themselves.
2. **Hermetic.** No network, no database, no installed global tool beyond `bash`,
   coreutils, `git` and `node`. A test that needs something it cannot get exits 2 with
   `CANNOT MEASURE: <reason>`; it never reports green for something it did not check.
3. **Exit codes:** 0 passed, 1 a check failed, 2 could not measure.
4. **Anti-vacuity.** A guard ships with a control (unmutated input is GREEN) and at least
   one mutant (a seeded defect makes it RED and the finding names the defect). See
   `scripts/test/lib/anti-vacuity.sh` and `scripts/test/anti-vacuity.test.sh`.
5. **Assert behaviour, not text.** Run the thing and check its output or exit code
   rather than grepping its source.
