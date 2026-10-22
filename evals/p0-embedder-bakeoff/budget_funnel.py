#!/usr/bin/env python3
"""Budget-assembly funnel — reconstruct the DOWNSTREAM coverage loss under gemma.

Grounding: gemma flat-dense STRICT@8 (ALL gold in top-8) = 97.4% (458/470) is the
RANKING ceiling. The live path then packs the top-8 hit sessions into an answerer
context under a chunk/char budget (moat_pilot.retrieve_graph / densify.evaluate:
GE_CAP chunks, GE_CHAR_BUDGET chars). If the budget fills before an in-top-8 gold
session is included, that gold is DROPPED — coverage falls below the 97.4% ceiling.

This script measures EXACTLY that loss with ZERO new embedding work, reusing:
  - gemma.jsonl        : the gemma flat-dense per-question ranked top-8 (= phase1) + gold
  - the LME corpus     : session content -> chunk sizes (chunk_text is VERBATIM the
                         run_eval_m2 rule recovered in p0_coverage.py)
The budget assembly is verbatim the phase1-only path of moat_pilot.retrieve_graph
(the "vector-only baseline" densify.py reports = 85.5% under MiniLM).

All knobs are CONFIG (env-overridable) — no magic numbers. Sweeps the budget to show
how much reachable gold the current 36-chunk / 150000-char cap drops, and what a
config change recovers.
"""
import json, os, sys, re

CHUNK_SIZE = int(os.getenv('LME_CHUNK_SIZE', '6000'))
GE_CAP = int(os.getenv('GE_CAP', '36'))               # chunk cap (current live default)
GE_CHAR_BUDGET = int(os.getenv('GE_CHAR_BUDGET', '150000'))  # char cap (current live default)
GE_TOPHITS = int(os.getenv('GE_TOPHITS', '8'))
CORPUS = os.getenv('LME_CORPUS',
                   os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                'data', 'longmemeval_s_cleaned.json'))
GEMMA = os.getenv('GEMMA_JSONL', '/tmp/gemma.jsonl')

C0_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def session_content(session, date):
    lines = [f"[Session date: {date}]"] if date else []
    for turn in session:
        lines.append(f"{turn.get('role', '?')}: {turn.get('content', '')}")
    return C0_RE.sub('', "\n".join(lines))


def chunk_text(content, size):
    if not content:
        return [""]
    return [content[i:i + size] for i in range(0, len(content), size)]


def assemble(phase1, sizes, gold, ge_cap, ge_char_budget):
    """Verbatim phase1-only budget assembly (moat_pilot.retrieve_graph / densify.evaluate).
    sizes[sid] = list of chunk char-lengths for that session.
    Returns (coverage_bool_allgold, used_sessions)."""
    used, tc, ch, parts = [], 0, 0, 0
    p1 = set(phase1)
    for sid in phase1:
        c = sizes.get(sid, [])
        nb = len(c)
        block_len = sum(c) + max(0, nb - 1)  # chunks joined by "\n"
        if parts and (tc + nb > ge_cap or ch + block_len > ge_char_budget):
            if sid in p1:
                continue
            break
        parts += 1; tc += nb; ch += block_len; used.append(sid)
        if tc >= ge_cap or ch >= ge_char_budget:
            break
    return set(gold).issubset(set(used)), used


def main():
    ds = json.load(open(CORPUS))
    by_qid = {p['question_id']: p for p in ds}
    recs = [json.loads(l) for l in open(GEMMA) if l.strip()]

    # per-question session chunk sizes (only the sessions we need: the ranked top-8)
    n = len(recs)
    ceiling = 0            # strict@8 (gold subset of top-8), no budget
    cur_cov = 0            # coverage under CURRENT budget
    dropped_examples = []
    # sweeps to demonstrate recovery (config-driven)
    sweeps = [(GE_CAP, GE_CHAR_BUDGET), (48, 150000), (64, 200000),
              (10**9, 10**9)]  # last = unbounded (== ranking ceiling)
    sweep_cov = {s: 0 for s in sweeps}

    for r in recs:
        qid = r['question_id']
        prob = by_qid[qid]
        ranked = r['ranked_sessions'][:GE_TOPHITS]
        gold = r['gold_sessions']
        # build chunk sizes for the sessions in play
        sids = prob['haystack_session_ids']
        sessions = prob['haystack_sessions']
        dates = prob.get('haystack_dates', [None] * len(sessions))
        need = set(ranked) | set(gold)
        sizes = {}
        for i, sid in enumerate(sids):
            if sid not in need:
                continue
            date = dates[i] if i < len(dates) else None
            chunks = chunk_text(session_content(sessions[i], date), CHUNK_SIZE)
            sizes.setdefault(sid, [])
            sizes[sid].extend(len(c) for c in chunks)

        if set(gold).issubset(set(ranked)):
            ceiling += 1
        cov_now, used = assemble(ranked, sizes, gold, GE_CAP, GE_CHAR_BUDGET)
        if cov_now:
            cur_cov += 1
        elif set(gold).issubset(set(ranked)):
            # gold was IN top-8 but budget dropped it — the recoverable loss
            missing = [g for g in gold if g not in set(used)]
            if len(dropped_examples) < 12:
                dropped_examples.append((qid, len(gold), missing,
                                         sum(sum(sizes.get(g, [])) for g in gold)))
        for s in sweeps:
            cov, _ = assemble(ranked, sizes, gold, s[0], s[1])
            if cov:
                sweep_cov[s] += 1

    print(f"n = {n} answerable questions   chunk_size={CHUNK_SIZE}")
    print(f"GEMMA flat-dense STRICT@8 (ranking ceiling, no budget) : {100*ceiling/n:.1f}%  ({ceiling}/{n})")
    print(f"  under CURRENT budget  cap={GE_CAP}ch / {GE_CHAR_BUDGET}chars : "
          f"{100*cur_cov/n:.1f}%  ({cur_cov}/{n})")
    print(f"  BUDGET-TRUNCATION LOSS (recoverable) : {100*(ceiling-cur_cov)/n:.1f}pt  "
          f"({ceiling-cur_cov} questions had all-gold in top-8 but budget dropped it)")
    print("\nBudget sweep (config GE_CAP / GE_CHAR_BUDGET -> strict coverage):")
    for s in sweeps:
        label = "UNBOUNDED (==ceiling)" if s[0] > 10**8 else f"{s[0]}ch / {s[1]}chars"
        print(f"  {label:<28} : {100*sweep_cov[s]/n:.1f}%  ({sweep_cov[s]}/{n})")
    print("\nExamples where all-gold was in top-8 but the current budget dropped it:")
    for qid, ng, missing, goldchars in dropped_examples:
        print(f"  {qid}  n_gold={ng}  gold_chars={goldchars}  dropped={missing}")


if __name__ == '__main__':
    main()
