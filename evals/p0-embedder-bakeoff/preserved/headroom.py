import json
R = "reports/"
D = "longmemeval-baseline/"

# per-question coverage from the frozen arm B run
cov = {}
for l in open(R + "longmemeval-armB-mandrel-perq.jsonl"):
    r = json.loads(l)
    cov[r["question_id"]] = r

qa = {}
for l in open(D + "hypotheses-armB-mandrel.checkpoint.jsonl"):
    r = json.loads(l)
    qa[r["question_id"]] = r

full = part = 0
wrong_full = wrong_part = 0
by_type = {}
for qid, r in cov.items():
    if qid.endswith("_abs"):
        continue
    c8 = (r.get("coverage_at_k") or {}).get("8")
    if c8 is None:
        continue
    t = r.get("question_type")
    bt = by_type.setdefault(t, {"n": 0, "partial": 0, "wrong": 0, "wrong_partial": 0})
    bt["n"] += 1
    correct = qa.get(qid, {}).get("qa_correct")
    if c8 >= 1.0:
        full += 1
        if correct is False:
            wrong_full += 1
    else:
        part += 1
        bt["partial"] += 1
        if correct is False:
            wrong_part += 1
            bt["wrong_partial"] += 1
    if correct is False:
        bt["wrong"] += 1

n = full + part
print(f"answerable with coverage data: {n}")
print(f"coverage@8 == 1.0 (all gold retrieved): {full} ({full/n:.1%})")
print(f"coverage@8 <  1.0 (graph-discovery headroom): {part} ({part/n:.1%})")
print(f"arm B WRONG answers: {wrong_full + wrong_part}")
print(f"  wrong WITH full coverage (assembly/reasoning failure): {wrong_full}")
print(f"  wrong WITH partial coverage (discovery failure -> graph could help): {wrong_part}")
print("\nby type: n / partial-coverage / wrong / wrong+partial")
for t, b in sorted(by_type.items()):
    print(f"  {t:<28} {b['n']:>3}  {b['partial']:>3}  {b['wrong']:>3}  {b['wrong_partial']:>3}")
