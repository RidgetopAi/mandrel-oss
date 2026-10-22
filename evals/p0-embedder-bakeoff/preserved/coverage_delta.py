import json
R = "reports/"
D = "longmemeval-baseline/"
covB = {}
for l in open(R + "longmemeval-armB-mandrel-perq.jsonl"):
    r = json.loads(l)
    covB[r["question_id"]] = r
qaB = {}
for l in open(D + "hypotheses-armB-mandrel.checkpoint.jsonl"):
    r = json.loads(l)
    qaB[r["question_id"]] = r.get("qa_correct")

n = 0
sumB = sumC = 0.0
full_b = full_c = 0
rescued_cov = []   # questions where C reaches FULL gold coverage and B didn't
by_type = {}
for l in open(D + "hypotheses-armC-headroom68-ro.jsonl"):
    r = json.loads(l)
    q = r["question_id"]
    gold = set(r["gold_sessions"])
    hs = None  # map in-context session idx -> ids via dataset? already have ids:
    # gold_sessions_in_context holds INDICES; recompute coverage from stored fields:
    # use r['gold_sessions_in_context'] (indices of gold present in context) vs |gold|
    c_cov = len(r["gold_sessions_in_context"]) / max(1, len(gold))
    b_cov = (covB[q].get("coverage_at_k") or {}).get("8") or 0.0
    n += 1
    sumB += b_cov
    sumC += c_cov
    if b_cov >= 1.0:
        full_b += 1
    if c_cov >= 1.0:
        full_c += 1
        if b_cov < 1.0:
            rescued_cov.append((q, r["question_type"], qaB.get(q)))
    t = r["question_type"]
    bt = by_type.setdefault(t, {"n": 0, "dB": 0.0, "dC": 0.0})
    bt["n"] += 1
    bt["dB"] += b_cov
    bt["dC"] += c_cov

print(f"n={n} (the 68 partial-coverage hard slice)")
print(f"mean in-context gold coverage:  armB={sumB/n:.3f}   armC-graph={sumC/n:.3f}")
print(f"FULL-coverage questions:        armB={full_b}   armC-graph={full_c}")
print(f"coverage-rescued (C full, B partial): {len(rescued_cov)}")
print("  of which arm B answered WRONG (the real QA upside):",
      sum(1 for _, _, ok in rescued_cov if ok is False))
print("\nby type (mean cov B -> C):")
for t, b in sorted(by_type.items()):
    print(f"  {t:<28} n={b['n']:>2}  {b['dB']/b['n']:.3f} -> {b['dC']/b['n']:.3f}")
print("\ncoverage-rescued list (qid, type, armB_qa):")
for row in rescued_cov:
    print("  ", row)
