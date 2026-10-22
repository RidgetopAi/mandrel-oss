# P0 embedder bake-off — RUNBOOK (operational)

Flat-dense (Arm A) retrieval harness plus a product-path driver. It measures, for each encoder
on the SAME corpus / chunking / metric, two numbers per question type and overall:

- **coverage@k** (any-gold): the fraction of questions where at least one gold session is in the top k.
- **strict@k** (all-gold): the fraction where EVERY gold session is in the top k. This is the number
  the release decision uses.

There is no answerer, no judge and no external API. Everything runs from this checkout.

## Layout
- `p0.config.json`    — models, per-model query/doc prefixes, k, chunk size, corpus path, endpoints (config, not hardcoded)
- `fetch_corpus.py`   — downloads the corpus and verifies its full sha256 (refuses on mismatch)
- `embed_server.mjs`  — MiniLM-L6 encoder (same model file and pooling as Mandrel's `localModel.ts`, offline, 384-d); loads from `mcp-server/vendor/models`
- `p0_coverage.py`    — flat-dense retrieval runner: coverage@k and strict@k (Ollama for the 4 local models, MiniLM via `embed_server.mjs`)
- `p0_product_path.py`— product-path driver: `context_store` then `smart_search` against a running Mandrel server, same scorer
- `tests/`            — `python3 -m unittest discover -s tests` (also run by `scripts/test/p0-evals.test.sh`)
- `preserved/`        — earlier analysis scripts
- `out/`              — per-model `coverage-<key>.json`, `summary.json`, `product/`

All commands below run from the repository root of a mandrel-oss checkout.

## Prereqs
- Python 3 and Node 20+.
- `cd mcp-server && npm ci` — installs `@xenova/transformers`, which `embed_server.mjs` loads. The MiniLM model itself is vendored at `mcp-server/vendor/models/Xenova/all-MiniLM-L6-v2`.
- For the Ollama models: Ollama running on `:11434` with `nomic-embed-text`, `qwen3-embedding:0.6b`, `embeddinggemma`, `snowflake-arctic-embed2` pulled.
- For the product-path driver: a running Mandrel server with the HTTP bridge (default `http://localhost:8080`). If the bridge needs a bearer token, put it in `MANDREL_BRIDGE_TOKEN`.

## Corpus
LongMemEval-S, cleaned: Hugging Face dataset `xiaowu0162/longmemeval-cleaned`, file `longmemeval_s_cleaned.json`.
500 questions (470 answerable + 30 `_abs` abstention).
- URL: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
- sha256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`

```
cd evals/p0-embedder-bakeoff
python3 fetch_corpus.py        # -> data/longmemeval_s_cleaned.json; exits 1 and names both hashes on mismatch
```
Never substitute a different file: the reference numbers below only reproduce on this exact corpus.

## Run
```
cd evals/p0-embedder-bakeoff
# 1. MiniLM encoder up (any shell; use a second terminal, or `&` + `kill %1` when done)
EMBED_PORT=8390 node embed_server.mjs > out_embed_server.log 2>&1 &
curl -fsS http://127.0.0.1:8390/health
# 2. plumbing self-test (micro fixture, NOT the eval) — MiniLM only, needs no Ollama; expect ALL PASS
python3 p0_coverage.py --self-test
#    add an Ollama model explicitly:  python3 p0_coverage.py --self-test --models nomic
```

### Full answerable run (checkpointed, resumable)
Runs the 470 answerable questions, fast to slow so cheap models finish first. One JSONL record per
question is checkpointed; re-run the SAME command to resume.
```
mkdir -p out/full470
python3 p0_coverage.py --models minilm nomic embeddinggemma arctic qwen3 --out out/full470 | tee out/full470/run.log
```
- Subset / stratified smoke: `--qids-file qids_n12.txt` or `--sample-per-type N`.
- Outputs under `out/full470/`: `coverage-<key>.jsonl` (live checkpoint), `coverage-<key>.json`
  (summary with overall and per-type coverage/strict, plus per-question rows), `summary.json`, `qids.txt`.
- The final table prints `any-gold / strict` for every k, overall and per question type.

### Product path (recall through the server)
Ingests each question's sessions through `context_store` (one project per question, sessions stored in
date order, each prefixed with a `[LME-SESSION <id>]` marker line), queries through `smart_search`, and
scores with the same metrics. Re-run it after any embedder or search change.
```
cd evals/p0-embedder-bakeoff
python3 p0_product_path.py --base-url http://localhost:8080 --qids-file qids_n36.txt --out out/product
```
Each run creates new projects named `lme-p0-<run-id>-<question_id>` (`--run-id` to choose the id).
Delete them with `project_delete` when done; a full 470-question run leaves 470 projects.

## Reference numbers (strict@8, answerable-only, measured)
| path | strict@8 |
|---|---|
| raw MiniLM-L6 (`p0_coverage.py --models minilm`) | 88.9 |
| product path (`p0_product_path.py`) | 91.7 |
| embeddinggemma raw (`p0_coverage.py --models embeddinggemma`) | 97.4 |

## Runtime
Chunking is 6000 characters. Measured on the full answerable set: ~106 chunks per question,
50,033 chunks in total. Throughput on CPU only, no GPU (chunks/s measured on real 6000-char chunks):

| model | dim | chunks/s | full-answerable (50,033 chunks) |
|---|---|---|---|
| MiniLM-L6 | 384 | 8.83 | ~1.6 h |
| nomic | 768 | 0.75 | ~18.5 h |
| embeddinggemma | 768 | 0.52 | ~27 h |
| arctic-l-v2 | 1024 | 0.22 | ~63 h |
| Qwen3-0.6b | 1024 | 0.17 | ~82 h |

Ollama already saturates all cores per request, so running models concurrently gives about no speedup.
Levers: run only the cheap models, or move the 1024-d models to a GPU box.
