#!/usr/bin/env python3
"""Characterize the residual coverage misses under the best densified graph
(khead5), and test T=0.45. For each still-missed gold session: what is its best
similarity to (a) any phase-1 session, (b) ANY other session in the project?
Buckets tell us whether a lower threshold, more K, or a DIFFERENT SIGNAL is needed."""
import json, glob, os, sys
sys.path.insert(0, '/tmp')
import densify as DZ

def run_variant(prims, T, hops, F):
    DZ.T = T
    DZ.prim = {}
    cache = {}
    def edges_for(p):
        if p not in cache:
            sets = [DZ.derive(p, pr) for pr in prims]
            cache[p] = DZ.combine(*sets)
        return cache[p]
    return edges_for

def main():
    dumps = {}
    for fp in glob.glob(os.path.join(DZ.BOOKS, '*.json')):
        d = json.load(open(fp))
        if not d.get('abstention'):
            dumps[d['question_id']] = d

    # T sweep on khead5
    for T in (0.5, 0.45):
        DZ.T = T
        cache = {}
        covs = []
        fj = fjc = 0
        for qid, d in dumps.items():
            p = f'lmec-{qid}'.lower()[:60]
            if p not in cache:
                cache[p] = DZ.derive(p, 'khead:5')
            cov, p2g, junk, jch = DZ.evaluate(d, cache[p], 1, 0.0)
            covs.append((qid, cov))
            fj += junk; fjc += jch
        n = len(covs)
        full = sum(1 for _, c in covs if c >= 1.0)
        print(f'khead5 T={T}: full500 fullcov {full}/{n} = {full/n:.1%}  '
              f'meancov {sum(c for _, c in covs)/n:.3f}  junk/q {fj/n:.2f}  junkKch/q {fjc/n/1000:.1f}')
        if T == 0.45:
            missed = [(q, c) for q, c in covs if c < 1.0]

    # residual analysis at T=0.45 (the most permissive similarity graph testable)
    print(f'\nresidual missed questions at khead5/T=0.45: {len(missed)}')
    b_isolated = b_belowT = b_budget = 0
    for qid, cov in missed:
        d = dumps[qid]
        p = f'lmec-{qid}'.lower()[:60]
        p1 = set(d['phase1'])
        gold = set(d['gold_idx'])
        # sessions of gold not in phase1
        # rebuild session-pair best sims from the dump (all pairs >= 0.45)
        pair_best = {}
        for lid, eid, sim in DZ.proj_pairs[p]:
            a, b = DZ.chunk_sess.get(lid), DZ.chunk_sess.get(eid)
            if a is None or b is None or a == b:
                continue
            k = (min(a, b), max(a, b))
            pair_best[k] = max(pair_best.get(k, 0), sim)
        for g in gold - p1:
            best_p1 = max((pair_best.get((min(g, s), max(g, s)), 0) for s in p1),
                          default=0)
            best_any = max((v for k, v in pair_best.items() if g in k), default=0)
            if best_any < 0.45:
                b_isolated += 1     # no >=0.45 similarity to ANYTHING: signal absent
            elif best_p1 >= 0.45:
                b_budget += 1       # connected to phase1 >=0.45 but lost to budget/K
            else:
                b_belowT += 1       # connected somewhere, but not to phase-1
    tot = b_isolated + b_belowT + b_budget
    print(f'missed gold sessions (outside phase1): {tot}')
    print(f'  semantically ISOLATED (<0.45 to everything): {b_isolated} ({b_isolated/max(1,tot):.0%})'
          f'\n  connected somewhere but NOT to phase-1:      {b_belowT} ({b_belowT/max(1,tot):.0%})'
          f'\n  connected to phase-1 >=0.45 (K/budget loss): {b_budget} ({b_budget/max(1,tot):.0%})')

if __name__ == '__main__':
    main()
