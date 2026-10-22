# LongMemEval A/B — Mandrel vs. a "wiki" baseline (2026-06-18)

**Headline:** Retrieval is a tie (commodity). Mandrel's win is **context assembly**: same encoder, same answerer, same judge, same prompt — **Mandrel answers +9.6 points better**, concentrated on the reasoning-heavy types (temporal +17, multi-session +13).

> Stand on this: *"Mandrel makes the same model answer ~10 points better than a wiki."* Not "we retrieve better" — that's commodity and the data says so.

---

## Setup (the only variable is retrieval)

| | |
|---|---|
| Dataset | official **LongMemEval-S**, 500 questions (470 answerable + 30 abstention) |
| Encoder (BOTH arms) | `Xenova/all-MiniLM-L6-v2`, 384-dim, mean-pool + L2-normalize |
| **Arm A — wiki** | flat top-k **cosine** over raw session chunks; top-8 chunks → answerer |
| **Arm B — Mandrel** | same top-k cosine (`context_search`) **+ session-expansion** (expand each hit to its full session, ~28k-token budget) → answerer |
| Answerer (BOTH) | OpenAI **gpt-4.1-mini**, temp 0 |
| Judge | OpenAI **gpt-4o** (LongMemEval paper standard), via official `evaluate_qa.py` |
| Prompt | held constant (`--prompt-variant improved`) |
| Cost | ~$5.8 total |

Recall@k = top-k of the **ordered ranked session list** includes a gold answer-session. **Answerable-only denominator (470)** — abstention questions have no gold session, excluded (this is the 97.2% vs 91.4% distinction). Recall is judge- and model-independent.

---

## Result 1 — Retrieval is a TIE (470 answerable)

| arm | recall@1 | recall@3 | recall@5 | recall@8 |
|---|---|---|---|---|
| Wiki | 0.815 | 0.928 | 0.955 | 0.972 |
| Mandrel | 0.821 | 0.934 | 0.953 | 0.972 |

Same encoder + same cosine → **Mandrel does not retrieve better.** Session-expansion is a *post-retrieval* step; it does not change recall.

## Result 2 — QA: Mandrel +9.6 points (470 answerable)

| arm | QA accuracy |
|---|---|
| Wiki | 304/470 = **0.647** |
| Mandrel | 349/470 = **0.743** |

### By question type (QA, with recall@1 / recall@8)

| type | n | wiki QA | Mandrel QA | Δ | wiki r@1 | Mand r@1 | wiki r@8 | Mand r@8 |
|---|---|---|---|---|---|---|---|---|
| **temporal-reasoning** | 127 | 0.52 | 0.69 | **+17** | 0.76 | 0.79 | 0.96 | 0.97 |
| **multi-session** | 121 | 0.57 | 0.70 | **+13** | 0.82 | 0.86 | 0.98 | 0.99 |
| single-session-user | 64 | 0.83 | 0.92 | +9 | 0.72 | 0.69 | 0.92 | 0.89 |
| knowledge-update | 72 | 0.69 | 0.71 | +2 | 0.88 | 0.86 | 1.00 | 1.00 |
| single-session-preference | 30 | 0.40 | 0.43 | +3 | 0.77 | 0.70 | 0.97 | 0.97 |
| single-session-assistant | 56 | 0.96 | 0.96 | 0 | 0.98 | 0.98 | 1.00 | 1.00 |

## Result 3 — Mechanism: it's context assembly, NOT ranking

- Mandrel hands the model **1.87× more context** (avg 71,500 vs 38,186 chars) — whole sessions vs isolated chunks.
- On the **454 questions where BOTH arms retrieved the gold session** (recall identical): Mandrel **saves 67**, wiki saves 27 → **net +40 correct answers from identical recall.** If this were re-ranking, equal recall would mean equal answers. It doesn't.

---

## Conclusions

1. **Positioning = outcomes.** Mandrel makes the same model answer ~10 pts better than a wiki; the win is real where you need the *whole conversation* (temporal, multi-session).
2. **Retrieval ranking is commodity** on this benchmark (a flat-vector wiki ties us). Don't build the pitch on it.
3. **Living Summary has an empirical target.** `knowledge-update` (+2) is the one hard type assembly barely beats the wiki — because retrieval hands the model *every* version of a changed fact, not *which is current*. A maintained current-state summary is the structural fix. Make it a **3rd arm (Mandrel+LS)** and watch knowledge-update + temporal.

---

## Files (this dir)

- `hypotheses-armA-wiki.jsonl` / `hypotheses-armB-mandrel.jsonl` — per-question: `recall_at_k`, `qa_correct`, `ranked_sessions`, `question_type`, `abstention`. **Reproduces every number above.**
- `longmemeval-{armA-wiki,armB-mandrel}-recall.json` — recall aggregates.
- `RUN_CONFIG.md` — pinned config (encoder, retrieval, answerer, judge, k, dataset).
- Full per-question `retrieved_context` dumps (bulky) live in `reports/longmemeval-arm*-results.json` on the VPS; retained via backup (see eval-backup task).
- Live dashboard: `coordinator.example.com/longmemeval-ab.html`.
- Mandrel: methodology result an earlier decision.
