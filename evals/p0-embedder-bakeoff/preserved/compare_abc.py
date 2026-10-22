import json
D = "longmemeval-baseline/"
C = {}
for l in open(D + "hypotheses-armC-smoke8.jsonl"):
    r = json.loads(l)
    C[r["question_id"]] = r

def load(path):
    d = {}
    for l in open(path):
        r = json.loads(l)
        if r.get("question_id") in C:
            d[r["question_id"]] = r
    return d

B = load(D + "hypotheses-armB-mandrel.checkpoint.jsonl")
A = load(D + "hypotheses-armA-wiki.checkpoint.jsonl")
hdr = "qid              type                         A  B  C   inf/heads  sims_top5"
print(hdr)
for q, c in C.items():
    a = "Y" if A.get(q, {}).get("qa_correct") else "N"
    b = "Y" if B.get(q, {}).get("qa_correct") else "N"
    cc = "Y" if c["qa_correct"] else "N"
    heads = c["n_sessions"]
    print(f"{q:<16} {c['question_type']:<28} {a}  {b}  {cc}   "
          f"{c['inferred_edges_minted']}/{heads}  "
          f"{c['inference_similarities_top10'][:5]}")
    print(f"   reasons={c['inference_reasons']}  ctx_chars={c['graph']['context_chars']}"
          f"  p1={len(c['graph']['phase1_sessions'])} p2={len(c['graph']['phase2_sessions'])}"
          f"  threads={c['graph']['threads_walked']}")
    if not c["qa_correct"]:
        print(f"   HYP: {c['hypothesis'][:160]}")
