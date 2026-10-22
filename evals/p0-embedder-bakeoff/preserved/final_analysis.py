#!/usr/bin/env python3
"""Arm C full-run analysis vs frozen Arm B (and Arm A) -- paired, per question.
Outputs: overall + by-type QA (answerable-only), recall-parity check,
dilution accounting (rescues vs regressions), graph-contribution lens."""
import json
D = "longmemeval-baseline/"

C = {}
for l in open(D + "hypotheses-armC-full.jsonl"):
    r = json.loads(l)
    C[r["question_id"]] = r

def load_ckpt(path):
    d = {}
    for l in open(path):
        r = json.loads(l)
        d[r["question_id"]] = r
    return d

B = load_ckpt(D + "hypotheses-armB-mandrel.checkpoint.jsonl")
A = load_ckpt(D + "hypotheses-armA-wiki.checkpoint.jsonl")

print(f"arm C records: {len(C)}  (expect 500)")

# ---- QA overall + by type (answerable-only primary, abstention separate) ----
def qa_tab(arm, label):
    ans = {q: r for q, r in arm.items() if not q.endswith("_abs")}
    absr = {q: r for q, r in arm.items() if q.endswith("_abs")}
    n = len(ans)
    c = sum(1 for r in ans.values() if r.get("qa_correct"))
    print(f"\n{label}: answerable QA = {c}/{n} = {c/max(1,n):.3f}"
          f"   abstention = {sum(1 for r in absr.values() if r.get('qa_correct'))}/{len(absr)}")
    bt = {}
    for r in ans.values():
        t = r["question_type"]
        b = bt.setdefault(t, [0, 0])
        b[1] += 1
        b[0] += 1 if r.get("qa_correct") else 0
    return {t: (v[0], v[1]) for t, v in bt.items()}

btC = qa_tab(C, "ARM C (graph, T=0.5 F=0.5)")
btB = qa_tab(B, "ARM B (frozen)")
btA = qa_tab(A, "ARM A (frozen)")
print(f"\n{'type':<28} {'n':>4} {'A':>6} {'B':>6} {'C':>6} {'C-B':>6}")
for t in sorted(btB):
    cb, nb = btB[t]
    cc, nc = btC.get(t, (0, 0))
    ca, na = btA.get(t, (0, 0))
    print(f"{t:<28} {nb:>4} {ca/max(1,na):>6.3f} {cb/max(1,nb):>6.3f} "
          f"{cc/max(1,nc):>6.3f} {cc/max(1,nc)-cb/max(1,nb):>+6.3f}")

# ---- recall parity (should be ~arm-B-identical by construction) ----
print("\nrecall@k (answerable-only), C vs frozen B:")
for k in ["1", "3", "5", "8"]:
    hc = nc = hb = nb2 = 0
    for q, r in C.items():
        if q.endswith("_abs"):
            continue
        ck = r.get("recall_at_k") or {}
        if str(k) in ck or int(k) in ck:
            nc += 1
            hc += 1 if ck.get(str(k), ck.get(int(k))) else 0
        rb = B.get(q, {})
        bk = rb.get("recall_at_k") or {}
        if str(k) in bk or int(k) in bk:
            nb2 += 1
            hb += 1 if bk.get(str(k), bk.get(int(k))) else 0
    print(f"  k={k}: C={hc}/{nc}={hc/max(1,nc):.3f}   B={hb}/{nb2}={hb/max(1,nb2):.3f}")

# ---- paired dilution accounting ----
res = {}
for q, r in C.items():
    if q.endswith("_abs") or q not in B:
        continue
    b_ok = B[q].get("qa_correct")
    c_ok = r.get("qa_correct")
    t = r["question_type"]
    e = res.setdefault(t, {"rescue": 0, "regress": 0, "both": 0, "neither": 0})
    if b_ok and c_ok:
        e["both"] += 1
    elif not b_ok and not c_ok:
        e["neither"] += 1
    elif c_ok and not b_ok:
        e["rescue"] += 1
    else:
        e["regress"] += 1
print(f"\npaired C vs B (answerable): {'type':<28} rescue regress net")
tr = tg = 0
for t, e in sorted(res.items()):
    print(f"{'':<28}{t:<28} {e['rescue']:>6} {e['regress']:>7} {e['rescue']-e['regress']:>+4}")
    tr += e["rescue"]; tg += e["regress"]
print(f"{'TOTAL':<56} {tr:>6} {tg:>7} {tr-tg:>+4}")

# ---- graph contribution lens ----
gg = [r for q, r in C.items() if not q.endswith("_abs") and r.get("gold_sessions_via_graph_only")]
gg_used = [r for r in gg if set(r["gold_sessions_via_graph_only"]) & set(r["gold_sessions_in_context"] and
           [i for i in r["gold_sessions_via_graph_only"]])]
print(f"\nquestions where the graph put vector-missed GOLD in context: {len(gg)}")
w = sum(1 for r in gg if r.get("qa_correct"))
wb = sum(1 for r in gg if B.get(r["question_id"], {}).get("qa_correct"))
print(f"  of those: C correct {w}/{len(gg)}, frozen-B correct {wb}/{len(gg)}")
p2junk = sum(max(0, len(set(r['graph']['used_sessions']) - set(r['graph']['phase1_sessions'])) -
             len(r.get('gold_sessions_via_graph_only') or [])) for r in C.values())
print(f"  total junk phase-2 sessions admitted across run: {p2junk}")
