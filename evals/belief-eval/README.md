# Belief-layer honest-assessment gate (BL-8)

The durable, repeatable instrument the coordinator runs the belief-layer **ship assessment** with.
It measures the belief pipeline end-to-end on the real corpus, in a disposable DB,
with an **independent blind Opus judge** — so the ship call rests on measured evidence, not
the adjudicator grading its own homework. Nothing here deploys or touches prod.

> Tests-are-the-rock: the report-shaping logic (`src/services/belief/dryRunReport.ts`) is
> locked by `src/tests/beliefDryRunReport.unit.test.ts` in the main vitest suite (the CI gate).
> The Python judges below are the paid measurement instruments run on demand for a ship call.

## What gets minted

The reconciler mints ONE edge type, `possibly_supersedes`, with
`created_by = 'auto:belief-adjudicator'`. It annotates only — it changes no recall/trust
directly. The HARD `supersedes` tier was deleted in an earlier task (an inferred edge must
never be able to make a record invisible); see the `beliefDerivation.ts` module header.

The dry-run report (`beliefBackfillDryRun.ts`) emits `minted_edges` (total) and
`minted_detail` (each entry:
`from_id/to_id/edge_type/confidence/cosine/reason/from_content/to_content`).

## The protocol

### 1. Run the dry-run (full mint+reconcile over the real corpus)

Provision a disposable DB (same helper the CI gate + `run.sh` use — no prod, no drift), export the
real corpus to `corpus.json` (`[{id,type,content,created_at,kind,emb}]` with verbatim gemma
vectors), then run the full pipeline:

```bash
# disposable DB creds (dropped on exit) — see run.sh for the provision/trap pattern
eval "$(bash scripts/provision-test-db.sh "$DB" --print-env | sed 's/^/export /')"

cd mcp-server
MANDREL_EMBEDDER=gemma \
ADJRUN_CORPUS=/path/to/corpus.json \
ADJRUN_OUT=../evals/belief-eval/out/shipcheck-$(date +%s) \
BELIEF_ADJUDICATOR_API_KEY=...   # provider key from env, never committed
npx tsx scripts/beliefBackfillDryRun.ts
# → writes dryrun-result-<ts>.json with minted_edges + minted_detail
```

Free scaffold check first (no LLM spend): `ADJRUN_NOMINATE_ONLY=1` stops after nomination.
Cap a representative slice with `ADJRUN_MAX_PAIRS=N` (evenly sampled across the cosine band).

### 2. Blind-judge the mints

Independent Opus judge, **no rationale leak** (no anchoring on the adjudicator) and **full
content** (a decision buried deep in a record is visible):

```bash
export ANTHROPIC_API_KEY=...        # read by name from env only — never commit a key
python3 evals/belief-eval/judge-mints-blind.py \
  out/shipcheck-<ts>/dryrun-result-<ts>.json  out/shipcheck-<ts>/judge.json  corpus.json
```

The judge reports `fp_rate` and, critically, `buries_still_true_decision` (the dangerous
class).

### 3. Recall-probe the non-mints (false negatives)

Samples the pairs the system did NOT link, evenly across cosine, and asks the same blind judge
whether any is a genuine supersession we missed:

```bash
python3 evals/belief-eval/recall-probe.py \
  out/shipcheck-<ts>/dryrun-result-<ts>.json  out/shipcheck-<ts>/recall.json  corpus.json  150
# → fn_rate_in_sample + extrapolated_total_missed (of which involve a decision)
```

### 4. Check against the ship bar

Compare to the human-verified gold seed [`gold/spotcheck-2026-07-07.md`](gold/spotcheck-2026-07-07.md)
(the coordinator read 30/67 validation mints; confirmed the blind judge is trustworthy, not
rubber-stamping):

- **`buries_still_true_decision` = 0** — non-negotiable. The dangerous class (hiding a live
  decision) was absent at the operating point the gold seed was read at; a single bury is a stop.
- **Recall / FN rate** informational.

## Files

- `judge-mints-blind.py` — independent blind Opus judge of mints (anti-anchoring, full content).
  Env: `ANTHROPIC_API_KEY` (by name).
- `recall-probe.py` — non-mint false-negative probe. Env: `ANTHROPIC_API_KEY`.
- `gold/spotcheck-2026-07-07.md` — human-verified gold seed + ship bar rationale.
- `run.sh` — the deterministic scorecard gate (ollama adjudicator, disposable DB).
- `decision-run/score.py <dir>` / `decision-run/score-grok.py [dir]` — score the label
  artifacts in `<dir>` (default: `decision-run/` itself). Both read the shared vocabulary in
  `decision-run/adjvocab.py`, which knows the retired hard action AND the current soft one, so
  the recorded artifacts and a fresh run both score. **Exit codes are the verdict:** `0`
  measured · `2` unknown action in a label file (the vocabulary drifted — fix `adjvocab.py`
  deliberately) · `3` COULD NOT MEASURE (an axis population was empty; a zero denominator is
  never printed as a score).
- `run-subq.sh <config> <label> [outdir]` / `decision-run/score-subq.py <dir>` — the SubQ Snap
  bake-off: drives `scripts/adjScore.ts` with `provider=subq` (single), the
  Sonnet-5 baseline, or `tiered` (Snap tier-1 → Sonnet tier-2) over the 80 pairs; the scorer
  reports recall/precision vs the oracle and vs the Sonnet majority, the 4-verdict confusion,
  calibration buckets, p50/p95 latency and $/1k pairs. Recorded runs: `decision-run/subq-37b2f00d/`.
- `decision-run/heldout-*/` — the confirmation round's 150 HELD-OUT pairs (`select.sql`,
  read-only from prod), configs frozen in `frozen-configs.json` before any run, runs + blind Opus
  judgements in `runs/`; score with `decision-run/score-heldout.py decision-run/heldout-37b2f00d/runs`.
  `judge-pairs-blind.py` is the blind pair judge (no adjudicator output shown).
  Round 3 (claude-sonnet-5-5 as tier 2) is in `runs-sonnet55/`; its `score.txt` was produced by
  `EXTRA_RUN_DIRS=<runs-sonnet55> REFERENCE_CONFIGS=a-snapcv,b-snapcn,c-sonnet5,d-tiered
  SONNET_REF_CONFIG=c-sonnet5 COST_RATES_FILE=<runs-sonnet55>/cost-rates-2026-10-12.json
  python3 decision-run/score-heldout.py decision-run/heldout-37b2f00d/runs <runs-sonnet55>/heldout-scorecard.json`.
- Report shaper: `../../mcp-server/src/services/belief/dryRunReport.ts` (+ unit test).
- Full pipeline: `../../mcp-server/scripts/beliefBackfillDryRun.ts`.

**No secrets in this tree.** All API keys are read from env **by name only**; never commit a key.
`out/` is gitignored (run artifacts).
