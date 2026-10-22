#!/usr/bin/env python3
"""BLIND independent judge of belief-layer MINTS (Opus 4.8).

Fixes the anchoring + truncation flaws the auditor flagged:
  - does NOT show the judge the adjudicator's verdict/confidence/rationale (no agreement bias)
  - shows FULL record content (MAXC high) so a decision buried deep in a record is visible.
Reads a dry-run result's minted detail (uses full content from --corpus, not the 700-char
truncated copy). NO prod writes.
Usage: judge-mints-blind.py <result.json> <out.json> <corpus.json>

Two-tier (BL-8): the dry-run report now splits mints into `hard_detail` (supersedes — the
only recall-corrupting tier) and `soft_detail` (possibly_supersedes). Set env MINT_BUCKET to
pick which the judge scores. Default `minted_detail` = ALL mints (the validated behaviour);
use MINT_BUCKET=hard_detail to blind-judge JUST the HARD tier for the ship assessment.
"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

RESULT, OUT, CORPUS = sys.argv[1], sys.argv[2], sys.argv[3]
KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = "claude-opus-4-8"
MINT_BUCKET = os.environ.get("MINT_BUCKET", "minted_detail")  # or hard_detail / soft_detail
MAXC = 9000  # full-ish; handoffs are excluded so records fit

corpus = {r["id"]: r for r in json.load(open(CORPUS))}

SYS = (
"You are a rigorous, independent JUDGE of a memory system's 'supersession' decisions. "
"The system claims record FROM makes a specific factual claim in record TO now FALSE or OBSOLETE, "
"on the SAME specific subject (the current truth changed; TO should no longer be trusted as current).\n"
"Judge whether THIS claim is CORRECT, using ONLY the two records shown. Be strict — the common error "
"is calling it a supersession when both records are still true (FROM references/elaborates/continues "
"from TO without making TO false), when they are about different subjects, or when the arrow points "
"the wrong way. Historical/ledger facts (a deploy happened, a task completed) accumulate — a newer one "
"does NOT falsify an older one.\n"
"Return STRICT JSON only:\n"
'{"verdict":"correct"|"false_positive",'
'"failure_type":null|"different_subject"|"both_still_true"|"wrong_direction"|"restatement",'
'"buries_still_true_decision":true|false,'
'"reason":"<=20 words"}\n'
"buries_still_true_decision = true ONLY when TO contains a real technical DECISION or firm commitment "
"that is STILL valid, and this edge would wrongly hide it."
)

def full(rid, fallback):
    r = corpus.get(rid)
    return ((r.get("content") if r else None) or fallback or "")[:MAXC]

def judge(m):
    fromc = full(m["from_id"], m.get("from_content"))
    toc = full(m["to_id"], m.get("to_content"))
    user = (
        f"FROM (claimed to SUPERSEDE / replace TO):\n\"\"\"\n{fromc}\n\"\"\"\n\n"
        f"TO (claimed to be superseded):\n\"\"\"\n{toc}\n\"\"\"\n\n"
        "Is this supersession CORRECT? Return the strict JSON."
    )
    body = json.dumps({"model": MODEL, "max_tokens": 300, "system": SYS,
                       "messages": [{"role": "user", "content": user}]}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
                "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as r:
                d = json.loads(r.read())
            txt = d["content"][0]["text"].strip()
            if txt.startswith("```"):
                txt = txt.split("```")[1].lstrip("json").strip()
            v = json.loads(txt)
            return {"from_id": m["from_id"], "to_id": m["to_id"], "cosine": m.get("cosine"),
                    "confidence": m.get("confidence"), **v}
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            code = getattr(e, "code", None)
            if code == 429 or (code and 500 <= code < 600):
                time.sleep(2 * (attempt + 1)); continue
            return {"from_id": m["from_id"], "to_id": m["to_id"], "verdict": "ERROR", "reason": f"http {code}"}
        except Exception as e:
            if attempt == 3:
                return {"from_id": m["from_id"], "to_id": m["to_id"], "verdict": "ERROR", "reason": str(e)[:80]}
            time.sleep(1.5 * (attempt + 1))
    return {"from_id": m["from_id"], "to_id": m["to_id"], "verdict": "ERROR", "reason": "retries exhausted"}

_report = json.load(open(RESULT))
mints = _report.get(MINT_BUCKET, _report.get("minted_detail", []))
print(f"BLIND-judging {len(mints)} mints [bucket={MINT_BUCKET}] with {MODEL} (full content, no rationale leak)…", flush=True)
labels, t0 = [], time.time()
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = [ex.submit(judge, m) for m in mints]
    done = 0
    for f in as_completed(futs):
        labels.append(f.result()); done += 1
        if done % 25 == 0: print(f"  {done}/{len(mints)}", flush=True)

fp = [l for l in labels if l.get("verdict") == "false_positive"]
ok = [l for l in labels if l.get("verdict") == "correct"]
err = [l for l in labels if l.get("verdict") == "ERROR"]
buries = [l for l in labels if l.get("buries_still_true_decision") is True]
ft = {}
for l in fp: ft[l.get("failure_type")] = ft.get(l.get("failure_type"), 0) + 1
judged = len(ok) + len(fp)
summary = {"model": MODEL, "mode": "BLIND (no rationale, full content)", "bucket": MINT_BUCKET, "total_mints": len(mints),
           "judged": judged, "errors": len(err), "correct": len(ok), "false_positive": len(fp),
           "fp_rate": round(len(fp)/judged, 4) if judged else None,
           "buries_still_true_decision": len(buries), "fp_by_type": ft, "wall_s": round(time.time()-t0, 1)}
json.dump({"summary": summary, "labels": labels}, open(OUT, "w"), indent=2)
print("\n=== BLIND JUDGE SUMMARY ===")
print(json.dumps(summary, indent=2))
print(f"\nwrote {OUT}")
