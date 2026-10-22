#!/usr/bin/env python3
"""REAL-TOOL validation of the khead5 densification winner on the h68 slice.

For each h68 project (already ingested by the full2 run, graphs intact):
  1. derive the khead5 chunk-level edge picks offline (top-5 earlier cross-session
     candidates >= 0.5 per session-HEAD -- same rule the builder build would add
     to threadInference.ts),
  2. mint them through the PUBLIC `link` tool (idempotent; shipped edges remain),
  3. re-run the REAL pipeline: context_search top-8 -> recall_thread depth-2 per
     hit -> session reach -> budgeted assembly (sizes) -> coverage,
  4. compare to the offline simulation (expected h68 fullcov ~= 33).
Divergence would mean the sim is unfaithful (e.g. recall_thread maxNodes=50 cap).
Sandbox :8195 only.
"""
import json, os, sys, glob, time
from collections import defaultdict

sys.path.insert(0, '/tmp')
import densify as DZ
sys.path.insert(0, 'longmemeval-baseline')
import run_eval_m2 as H

BASE = os.getenv('MANDREL_BASE', 'http://localhost:8195')
assert ':8080' not in BASE and ':8190' not in BASE
H.MANDREL_BASE = BASE
GE_CAP, GE_CHAR_BUDGET = 36, 112000

import re
ID_RE = re.compile(r'ID:\s*([0-9a-f]{8}-[0-9a-f-]{27,})')

def sc(resp):
    return (resp.get('result') or {}).get('structuredContent') or {}

def khead5_chunk_pairs(p, T=0.5, K=5):
    hs = set(DZ.heads_of(p).values())
    idx = DZ.later_index(p)
    pairs = []
    for ts, cid, s in DZ.proj_chunks[p]:
        if cid not in hs:
            continue
        n = 0
        for sim, eid in idx.get(cid, []):
            if sim < T:
                break
            if DZ.chunk_sess.get(eid) == s:
                continue
            pairs.append((cid, eid, sim))
            n += 1
            if n >= K:
                break
    return pairs

def parse_hits(txt):
    hits, cur = [], None
    for line in (txt or '').splitlines():
        tm = H.TAG_RE.search(line)
        if tm:
            m = H.SESS_RE.search(tm.group(1))
            cur = int(m.group(1)) if m else None
            continue
        im = ID_RE.search(line)
        if im and cur is not None:
            hits.append((im.group(1), cur))
            cur = None
    return hits

def main():
    h68 = [l.strip() for l in open(DZ.H68) if l.strip()]
    ds = json.load(open('longmemeval-baseline/'
                        'LongMemEval/data/longmemeval_s_cleaned.json'))
    probs = {p['question_id']: p for p in ds if p['question_id'] in set(h68)}
    dumps = {}
    for fp in glob.glob(os.path.join(DZ.BOOKS, '*.json')):
        d = json.load(open(fp))
        if d['question_id'] in probs:
            dumps[d['question_id']] = d

    full = 0
    covs = []
    minted_total = 0
    for i, qid in enumerate(h68):
        prob, d = probs[qid], dumps[qid]
        p = f'lmec-{qid}'.lower()[:60]
        H.mandrel('project_switch', {'project': p})
        # 2. mint khead5 edges via the public link tool (idempotent)
        for cid, eid, sim in khead5_chunk_pairs(p):
            r = H.mandrel('link', {'from': cid, 'fromType': 'context',
                                   'to': eid, 'toType': 'context',
                                   'edgeType': 'related_to',
                                   'metadata': {'source': 'khead5-prototype',
                                                'similarity': sim}})
            minted_total += 1
        # 3. real pipeline
        base = H.mandrel('context_search', {'query': prob['question'], 'limit': 8})
        hits = parse_hits(H.mandrel_text(base))
        phase1 = list(dict.fromkeys(s for _, s in hits[:8]))
        p1 = set(phase1)
        score = {}
        for cid, _s in hits[:8]:
            rt = H.mandrel('recall_thread', {'anchor': cid, 'altitude': 'headline',
                                             'depth': 2})
            for n_ in (sc(rt).get('nodes') or []):
                si = DZ.chunk_sess.get(n_.get('id'))
                if si is not None and si not in p1:
                    score[si] = max(score.get(si, 0), 0.001)
        # score admitted sessions by derived sims (client-side, F=0 for ceiling-parity)
        admitted = sorted(score, key=lambda s: -score[s])
        sizes = {int(k): v for k, v in d['sess_sizes'].items()}
        gold = set(d['gold_idx'])
        used, tc, ch, parts = [], 0, 0, 0
        for si in phase1 + admitted:
            c = sizes.get(si, []); bl = sum(c) + max(0, len(c) - 1)
            if parts and (tc + len(c) > GE_CAP or ch + bl > GE_CHAR_BUDGET):
                if si in p1:
                    continue
                break
            parts += 1; tc += len(c); ch += bl; used.append(si)
            if tc >= GE_CAP or ch >= GE_CHAR_BUDGET:
                break
        cov = len(gold & set(used)) / max(1, len(gold))
        covs.append(cov)
        full += 1 if cov >= 1.0 else 0
        print(f'[{i+1}/68] {qid} cov={cov:.2f} p2={len(admitted)}', flush=True)
    print(f'\nREAL-TOOL khead5 on h68: fullcov={full}/68  meancov={sum(covs)/len(covs):.3f}'
          f'  (offline sim predicted 33/68, 0.701)  link-calls={minted_total}')

if __name__ == '__main__':
    main()
