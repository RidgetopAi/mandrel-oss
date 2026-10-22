#!/usr/bin/env python3
"""BLIND Opus judge of candidate PAIRS (an earlier task confirmation round).

Unlike judge-mints-blind.py (which judges a claimed FROM->TO edge), this judges a PAIR from
scratch: no adjudicator's verdict, direction, confidence or rationale is shown. It sees both
records in full with their timestamps and answers whether the later one supersedes the earlier.
Used on every DISPUTED pair (any run of any config disagrees on the supersede decision or its
direction), as the independent check on the Sonnet-majority reference. NO prod writes.

usage: judge-pairs-blind.py <pairs.json> <keys.json> <out.json>
  keys.json = JSON list of "aId|bId" strings to judge (pairs.json orientation).
Env: ANTHROPIC_API_KEY (by name). JUDGE_MODEL (default claude-opus-4-8).
"""
import json, os, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

PAIRS, KEYS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = os.environ.get("JUDGE_MODEL", "claude-opus-4-8")
MAXC = 9000

SYS = (
    "You are a rigorous, independent JUDGE for a memory system. Two stored records are shown with their "
    "creation timestamps. Decide whether the LATER record SUPERSEDES the EARLIER one: on the SAME specific "
    "subject and scope, the later record makes a factual claim of the earlier one now FALSE or OBSOLETE "
    "(a different current value, or a changed status such as planned->done, proposed->locked). "
    "Be strict. It is NOT a supersession when the later record merely references, summarizes, continues, "
    "implements or builds on the earlier one; when both are still true; when they are about different "
    "subjects, systems or environments; or when they are historical/ledger facts that accumulate. "
    "Only the timestamps decide which record is later.\n"
    "Return STRICT JSON only:\n"
    '{"supersedes":true|false,"verdict":"supersedes"|"contests"|"restates"|"unrelated","reason":"<=25 words"}'
)


def judge(p):
    a, b = p["a"], p["b"]
    user = (
        f"RECORD A (type={a['type']}, created={a.get('createdAt')}):\n\"\"\"\n{(a.get('content') or '')[:MAXC]}\n\"\"\"\n\n"
        f"RECORD B (type={b['type']}, created={b.get('createdAt')}):\n\"\"\"\n{(b.get('content') or '')[:MAXC]}\n\"\"\"\n\n"
        "Does the LATER record supersede the EARLIER one? Return the strict JSON."
    )
    body = json.dumps({"model": MODEL, "max_tokens": 300, "system": SYS,
                       "messages": [{"role": "user", "content": user}]}).encode()
    k = f"{a['id']}|{b['id']}"
    for attempt in range(4):
        try:
            req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
                "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read())
            txt = d["content"][0]["text"].strip()
            if txt.startswith("```"):
                txt = txt.split("```")[1].lstrip("json").strip()
            v = json.loads(txt)
            return {"pair": k, "usage": d.get("usage"), **v}
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            code = getattr(e, "code", None)
            if code == 429 or (code and 500 <= code < 600):
                time.sleep(3 * (attempt + 1)); continue
            return {"pair": k, "supersedes": None, "error": f"http {code}"}
        except Exception as e:  # unparseable answer: retry, then record as ERROR (never a guess)
            if attempt == 3:
                return {"pair": k, "supersedes": None, "error": str(e)[:80]}
            time.sleep(1.5 * (attempt + 1))
    return {"pair": k, "supersedes": None, "error": "retries exhausted"}


pairs = {f"{p['a']['id']}|{p['b']['id']}": p for p in json.load(open(PAIRS))}
keys = json.load(open(KEYS))
missing = [k for k in keys if k not in pairs]
if missing:
    sys.exit(f"judge-pairs-blind: {len(missing)} keys not in {PAIRS}")
with ThreadPoolExecutor(max_workers=4) as ex:
    labels = list(ex.map(judge, [pairs[k] for k in keys]))
errs = sum(1 for l in labels if l.get("error"))
json.dump({"model": MODEL, "mode": "BLIND pair judgement (no adjudicator output shown)",
           "judged": len(labels) - errs, "errors": errs, "labels": labels}, open(OUT, "w"), indent=2)
print(f"judged {len(labels) - errs}/{len(labels)} ({errs} errors) with {MODEL} -> {OUT}")
sys.exit(3 if errs else 0)
