# LongMemEval A/B — Wiki baseline (Arm A) vs Mandrel (Arm B)

**One variable: how context is RETRIEVED.** Both arms feed the SAME answerer, SAME
judge, SAME prompt, SAME context budget, over the SAME dataset, using the SAME encoder.
The only thing that differs is the retriever. So any delta is Mandrel's *method*, not a
better model or encoder.

---

## Pinned config (identical across both arms unless noted)

| Knob | Value |
|---|---|
| Dataset | `LongMemEval/data/longmemeval_s_cleaned.json` — official LongMemEval-S, **500 questions** (470 answerable + 30 abstention) |
| Encoder (both arms) | **`Xenova/all-MiniLM-L6-v2`**, native **384-dim**, mean-pool + L2-normalize (quantized ONNX `model_quantized.onnx`) |
| Answerer (both arms) | **OpenAI `gpt-4.1-mini`** (resolves to `gpt-4.1-mini-2025-04-14`), **temperature 0** |
| Judge (both arms) | **OpenAI `gpt-4o`** (`gpt-4o-2024-08-06`) via the official `LongMemEval/src/evaluation/evaluate_qa.py` prompts, verbatim |
| Prompt | `--prompt-variant improved` (held constant) |
| Context budget | top-**8** retrieved sessions/chunks fed to the answerer (`--topk 8`) |
| Recall cutoffs | `RECALL_KS=1,3,5,8` (PRIMARY metric, **answerable-only**, denominator = 470) |

### Arm A — "wiki" baseline (`--retrieval flat_dense`)
Flat dense retrieval over the **raw** haystack: the same per-session formatting and same
6000-char chunking the Mandrel arm ingests, each chunk embedded with the **same encoder**
(via `embed_server.mjs`), the query embedded raw, **plain top-k cosine**, **NO
session-expansion, NO Mandrel logic, NO hybrid `Type:/Tags:` scaffolding**. This is what a
flat `.md` memory-bank + vector search gives you. Retrieval ordering is at the chunk level;
the ranked session list is derived by first-occurrence rank.

### Arm B — Mandrel (`--retrieval session_expansion`)
Mandrel's **actual** retrieval: `context_store` ingest (hybrid `Type:/Tags:/title/content`
embedding text) into a **per-question fresh disposable Mandrel project** on the disposable
instance, `context_search` + **session-expansion** + ranking. Mandrel stores its 384-dim
vectors zero-padded to 1536 then renormalized — which does **not** change cosine ranking vs
native 384, so the encoder is the same; the expansion/ranking is the *method* under test.
`SE_TOPHITS=8 SE_CAP=36 SE_TOKEN_BUDGET=28000`.

---

## Encoder fidelity (why "same encoder" is real, not a claim)

Mandrel's embedding is `@xenova/transformers` `Xenova/all-MiniLM-L6-v2`,
`{pooling:'mean', normalize:true}` (see
`mandrel/mcp-server/src/services/embedding/localModel.ts`). Arm A's `embed_server.mjs`
loads the **same `@xenova` package and the same cached ONNX model file** from
`mandrel/mcp-server/node_modules` with the same pooling/normalization. Verified offline
(`env.allowRemoteModels=false`): 384-dim, unit-norm.

Note the one document-side asymmetry that **belongs to Mandrel's method**: on store,
Mandrel embeds a hybrid string `Type:\nTags:\n<title>\n<content[:1000]>` (content truncated
to 1000 chars "to avoid dilution"), not the raw chunk. Arm A embeds the raw chunk. That
scaffolding is part of Mandrel's retrieval design, so the arms legitimately differ there;
the *encoder* (weights + tokenizer + pooling) is identical.

---

## Reproduce — one command per arm

Prereq for Arm A: the baseline embed server must be up (it IS the encoder):
```
cd /home/user/projects/riverbend/longmemeval-baseline
EMBED_PORT=8390 nohup node embed_server.mjs > embed_server.log 2>&1 &
curl -fsS http://127.0.0.1:8390/health
```
Prereq for Arm B: the disposable Mandrel must be up on `:8190` (throwaway `ci_*` DB).

Full 500-question runs used one launcher per arm (not part of this repository), as
`RUN_ID=armA-wiki` (wiki baseline) and `RUN_ID=armB-mandrel` (Mandrel). Smoke runs used the
fixed 8-question slice `QIDS_FILE=smoke8.qids` with `RUN_ID=armA-smoke` / `armB-smoke`.
Both launchers read `OPENAI_API_KEY` from `/opt/assistant/.env` inside the runner — the key is
never printed. Runs are resumable (fixed `--run-id` + checkpoint).

---

## Outputs (each run writes its own distinct JSON — additive, nothing overwritten)

Per `RUN_ID`, under `/home/user/projects/riverbend-reports/`:
- `longmemeval-<RUN_ID>-recall.json` — recall@k curve (overall + by_type), answerable-only
- `longmemeval-<RUN_ID>-live.json` — live progress + running recall@k + QA
- `longmemeval-<RUN_ID>-results.json` — per-question records, incl. `ranked_sessions`
  (ORDERED retrieved session-ids) and per-question `recall_at_k`
- `hypotheses-<RUN_ID>.jsonl` (+ `.checkpoint.jsonl`)

Each result/recall/live JSON stamps the full `config` (encoder + model, both retrieval
configs, answerer, judge, k, dataset, arm).

### Dashboard
`longmemeval-ab.html` (served at the reports root). Run
`python3 build_ab_manifest.py` to refresh `longmemeval-ab-manifest.json`; the page renders
both arms side-by-side (recall@k curve, QA accuracy, by-type) and keeps **all** prior runs
in the all-runs table.

---

## Isolation & secrets
- Arm A uses **no Mandrel at all** for retrieval (flat dense in-process).
- Arm B talks **only** to the disposable Mandrel on `:8190` (throwaway `ci_*` Postgres),
  per-question fresh project, retriever blind to gold. Never prod (`:8080`), never a tenant,
  never the `riverbend` project.
- OpenAI key (answerer + judge) is read from `/opt/assistant/.env` inside the runner and never
  echoed.

## Cost (full 500×2 QA run)
gpt-4.1-mini answerer (both arms) + gpt-4o judge (both arms). Target ≈ **$11**. The
answerer prompt is dominated by retrieved context (~15–25K input tokens/question);
gpt-4.1-mini input is cheap and completions are short. Judge calls are tiny
(`max_tokens=10`). See each run's `cost.cost_usd` / token counts for the actual spend.
