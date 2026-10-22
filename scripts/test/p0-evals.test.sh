#!/usr/bin/env bash
# p0-evals.test.sh — runs the embedder bake-off tooling tests (strict@k scoring, corpus fetch checksum
# refusal, product-path driver against a fake server, RUNBOOK/embed_server hygiene). Exit 0 = pass.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v python3 >/dev/null || { echo "python3 missing"; exit 1; }
command -v node >/dev/null || { echo "node missing"; exit 1; }
cd "$ROOT/evals/p0-embedder-bakeoff" && exec python3 -I -m unittest discover -s tests -v
