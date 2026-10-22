#!/usr/bin/env python3
"""True ceiling of similarity-signal densification:
  - MAXIMAL graph: every chunk-pair edge >= T (K=inf, all writes, both directions)
  - SMARTER assembly fill: on phase-2 overflow, SKIP the too-big session and keep
    trying smaller ones (current code BREAKs -- an assembly artifact, not a graph limit)
Also re-scores khead5 with the smarter fill alone, to separate graph gain from fill gain."""
import json, glob, os, sys
from collections import defaultdict
sys.path.insert(0, '/tmp')
import densify as DZ

def maximal_edges(p, T):
    edges = {}
    for lid, eid, sim in DZ.proj_pairs[p]:
        if sim < T:
            continue
        a, b = DZ.chunk_sess.get(lid), DZ.chunk_sess.get(eid)
        if a is None or b is None or a == b:
            continue
        k = (min(a, b), max(a, b))
        if sim > edges.get(k, 0):
            edges[k] = sim
    return edges

def evaluate2(dump, edges, hops, F, skip_fill):
    phase1 = dump['phase1']; p1 = set(phase1)
    adj = defaultdict(list)
    for (a, b), sim in edges.items():
        adj[a].append((b, sim)); adj[b].append((a, sim))
    score = {}
    for s in p1:
        for t2, sim in adj[s]:
            if t2 not in p1:
                score[t2] = max(score.get(t2, 0), sim)
    if hops == 2:
        for s1, sc1 in list(score.items()):
            for t2, sim in adj[s1]:
                if t2 not in p1 and t2 not in score:
                    score[t2] = min(sc1, sim)
    admitted = [s for s, v in sorted(score.items(), key=lambda x: (-x[1], x[0])) if v >= F]
    sizes = {int(k): v for k, v in dump['sess_sizes'].items()}
    gold = set(dump['gold_idx'])
    used, tc, ch, parts = [], 0, 0, 0
    for si in list(phase1) + admitted:
        c = sizes.get(si, []); bl = sum(c) + max(0, len(c) - 1)
        if parts and (tc + len(c) > DZ.GE_CAP or ch + bl > DZ.GE_CHAR_BUDGET):
            if si in p1 or skip_fill:
                continue
            break
        parts += 1; tc += len(c); ch += bl; used.append(si)
        if tc >= DZ.GE_CAP or ch >= DZ.GE_CHAR_BUDGET:
            break
    us = set(used)
    cov = len(gold & us) / max(1, len(gold))
    p2u = [s for s in used if s not in p1]
    junk = sum(1 for s in p2u if s not in gold)
    jch = sum(sum(sizes.get(s, [])) for s in p2u if s not in gold)
    return cov, junk, jch

def main():
    dumps = {}
    for fp in glob.glob(os.path.join(DZ.BOOKS, '*.json')):
        d = json.load(open(fp))
        if not d.get('abstention'):
            dumps[d['question_id']] = d
    h68 = set(l.strip() for l in open(DZ.H68) if l.strip())

    configs = [
        ('khead5 T=.5 break-fill (ref)', 'khead', 0.5, False, 1, 0.0),
        ('khead5 T=.5 skip-fill', 'khead', 0.5, True, 1, 0.0),
        ('MAXIMAL T=.5 skip-fill 1hop', 'max', 0.5, True, 1, 0.0),
        ('MAXIMAL T=.45 skip-fill 1hop', 'max', 0.45, True, 1, 0.0),
        ('MAXIMAL T=.45 skip-fill 2hop', 'max', 0.45, True, 2, 0.0),
        ('MAXIMAL T=.45 skip-fill 1hop F=.5', 'max', 0.45, True, 1, 0.5),
    ]
    print(f"{'config':<36}{'fullcov%':>9}{'meancov':>8}{'h68full':>8}{'junk/q':>7}{'junkKch':>8}")
    for label, kind, T, skipf, hops, F in configs:
        DZ.T = T
        cache = {}
        covs, covs68 = [], []
        fj = fjc = 0
        for qid, d in dumps.items():
            p = f'lmec-{qid}'.lower()[:60]
            key = (p, kind, T)
            if key not in cache:
                cache[key] = (DZ.derive(p, 'khead:5') if kind == 'khead'
                              else maximal_edges(p, T))
            cov, junk, jch = evaluate2(d, cache[key], hops, F, skipf)
            covs.append(cov)
            if qid in h68:
                covs68.append(cov)
            fj += junk; fjc += jch
        n = len(covs)
        print(f"{label:<36}{100*sum(1 for c in covs if c>=1)/n:>8.1f}%"
              f"{sum(covs)/n:>8.3f}{sum(1 for c in covs68 if c>=1):>8}"
              f"{fj/n:>7.2f}{fjc/n/1000:>8.1f}")

if __name__ == '__main__':
    main()
