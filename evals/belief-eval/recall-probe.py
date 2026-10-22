#!/usr/bin/env python3
"""RECALL probe — how many REAL supersessions did the system MISS?

Takes a run's all_results, samples the NON-mints (pairs the system did NOT link) evenly across
cosine, and asks the blind judge: is this actually a genuine supersession we missed (a false
negative)? Reports the FN rate and an extrapolated recall estimate.
Usage: recall-probe.py <result.json> <out.json> <corpus.json> <sample_n>
"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

RESULT, OUT, CORPUS = sys.argv[1], sys.argv[2], sys.argv[3]
SAMPLE_N = int(sys.argv[4]) if len(sys.argv) > 4 else 150
KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = "claude-opus-4-8"
MAXC = 9000

corpus = {r["id"]: r for r in json.load(open(CORPUS))}
data = json.load(open(RESULT))
res = data.get("all_results", [])
# NON-mints = pairs that did NOT produce an edge (system said "not a supersession")
nonmints = [r for r in res if not r.get("edgeCreated") and not r.get("error")]
nonmints.sort(key=lambda r: -float(r.get("cosine") or 0))
# even sample across the cosine-sorted non-mints
if len(nonmints) > SAMPLE_N:
    step = len(nonmints) / SAMPLE_N
    sample = [nonmints[int(i*step)] for i in range(SAMPLE_N)]
else:
    sample = nonmints

SYS = (
"You judge whether two memory records have a genuine SUPERSESSION relationship: one makes a "
"specific factual claim in the other now FALSE or OBSOLETE, on the SAME subject (the current truth "
"changed — the older should no longer be trusted as current). The system did NOT link these; you are "
"checking whether that was a MISS. Be STRICT: topical similarity, elaboration, continuation, or two "
"records that are both true (incl. accumulating history/ledger facts) are NOT supersession. "
"Return STRICT JSON only:\n"
'{"is_supersession":true|false,"direction":"a_supersedes_b"|"b_supersedes_a"|"none",'
'"involves_decision":true|false,"reason":"<=20 words"}'
)

def content(rid):
    r = corpus.get(rid)
    return ((r.get("content") if r else "") or "")[:MAXC]

def judge(p):
    a, b = content(p["aId"]), content(p["bId"])
    user = (f"RECORD A:\n\"\"\"\n{a}\n\"\"\"\n\nRECORD B:\n\"\"\"\n{b}\n\"\"\"\n\n"
            "Do these have a genuine supersession relationship (one makes the other false/obsolete)? Strict JSON.")
    body = json.dumps({"model": MODEL, "max_tokens": 250, "system": SYS,
                       "messages": [{"role": "user", "content": user}]}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
                "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.loads(r.read())
            txt = d["content"][0]["text"].strip()
            if txt.startswith("```"): txt = txt.split("```")[1].lstrip("json").strip()
            v = json.loads(txt)
            return {"aId": p["aId"], "bId": p["bId"], "cosine": p.get("cosine"),
                    "sys_verdict": p.get("verdict", {}).get("verdict"), **v}
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            code = getattr(e, "code", None)
            if code == 429 or (code and 500 <= code < 600): time.sleep(2*(attempt+1)); continue
            return {"aId": p["aId"], "bId": p["bId"], "is_supersession": None, "reason": f"http {code}"}
        except Exception as e:
            if attempt == 3: return {"aId": p["aId"], "bId": p["bId"], "is_supersession": None, "reason": str(e)[:80]}
            time.sleep(1.5*(attempt+1))
    return {"aId": p["aId"], "bId": p["bId"], "is_supersession": None, "reason": "retries exhausted"}

print(f"RECALL probe: {len(nonmints)} non-mints total, judging a {len(sample)}-sample across cosine…", flush=True)
labels, t0 = [], time.time()
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = [ex.submit(judge, p) for p in sample]
    done = 0
    for f in as_completed(futs):
        labels.append(f.result()); done += 1
        if done % 25 == 0: print(f"  {done}/{len(sample)}", flush=True)

missed = [l for l in labels if l.get("is_supersession") is True]
missed_dec = [l for l in missed if l.get("involves_decision") is True]
judged = [l for l in labels if l.get("is_supersession") in (True, False)]
fn_rate = len(missed)/len(judged) if judged else None
est_total_fn = round(fn_rate*len(nonmints)) if fn_rate is not None else None
summary = {"model": MODEL, "nonmints_total": len(nonmints), "sample_judged": len(judged),
           "missed_supersessions_in_sample": len(missed), "of_which_involve_a_decision": len(missed_dec),
           "fn_rate_in_sample": round(fn_rate, 4) if fn_rate is not None else None,
           "extrapolated_total_missed": est_total_fn, "wall_s": round(time.time()-t0, 1)}
json.dump({"summary": summary, "missed_examples": missed[:15], "labels": labels}, open(OUT, "w"), indent=2)
print("\n=== RECALL PROBE SUMMARY ===")
print(json.dumps(summary, indent=2))
print(f"\nwrote {OUT}")
