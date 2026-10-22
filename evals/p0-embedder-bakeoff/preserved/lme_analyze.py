import json
from collections import defaultdict
P="longmemeval-baseline/hypotheses-armC-full2.jsonl"
rows=[json.loads(l) for l in open(P)]
r0=rows[0]
print("coverage_at_k sample:", r0.get("coverage_at_k"), "| recall_at_k sample:", r0.get("recall_at_k"))
print("fields:", list(r0.keys()))

def cov(r):
    c=r.get("coverage_at_k")
    if isinstance(c,dict):
        try: return max(float(v) for v in c.values())
        except: return None
    return float(c) if c is not None else None

ans=[r for r in rows if not r.get("abstention")]
by=defaultdict(lambda:{"n":0,"correct":0,"gold_in":0,"wgi":0,"wgo":0})
tot={"reason":0,"retr":0,"wrong":0}
for r in ans:
    t=r["question_type"]; d=by[t]; d["n"]+=1
    ok=bool(r.get("qa_correct")); c=cov(r); gin=(c is not None and c>=0.999)
    if gin: d["gold_in"]+=1
    if ok: d["correct"]+=1
    else:
        tot["wrong"]+=1
        if gin: d["wgi"]+=1; tot["reason"]+=1
        else: d["wgo"]+=1; tot["retr"]+=1

hdr="{:<26}{:>4}{:>7}{:>12}{:>11}{:>9}".format("type","n","QA%","goldInCtx%","reasonFail","retrFail")
print(hdr)
for t,d in sorted(by.items(), key=lambda x:-x[1]["n"]):
    qa=100*d["correct"]/d["n"]; g=100*d["gold_in"]/d["n"]
    print("{:<26}{:>4}{:>7.1f}{:>12.1f}{:>11}{:>9}".format(t,d["n"],qa,g,d["wgi"],d["wgo"]))
tg=sum(1 for r in ans if (cov(r) or 0)>=0.999)
print()
print("OVERALL answerable={}  wrong={}  reasoningFail(gold WAS in ctx)={}  retrievalFail(gold MISSING)={}".format(len(ans),tot["wrong"],tot["reason"],tot["retr"]))
print("gold reached context on {}/{} = {:.1f}% (Mandrel doing its job)".format(tg,len(ans),100*tg/len(ans)))
