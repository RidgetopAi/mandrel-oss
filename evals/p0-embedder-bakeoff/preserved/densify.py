#!/usr/bin/env python3
"""$0 densification study — offline variant engine.

Derives candidate edge-sets from the sandbox's stored embeddings (dens_pairs.tsv:
the SAME pgvector cosine threadInference.ts computes, oriented later->earlier =
write-time direction, all BLIND to questions), simulates the session-level walk +
budgeted assembly for each variant, measures coverage + junk.

VARIANTS (all mechanical / write-time-derivable; no Q&A knowledge anywhere):
  base1      current shipped rule (approx): HEAD writes mint top-1 earlier chunk >= T
  kheadK     multi-edge inference, heads only: top-K earlier chunks >= T   (K=2,3,5)
  kallK      multi-edge inference, EVERY write: top-K earlier chunks >= T (K=2,3)
  sessK      session-level: heads -> top-K earlier HEADS >= T             (K=3)
  temporal   chronological chain: head_i <-> head_{i-1} (structural, simless)
  combos     khead3+temporal, kall2+temporal, sess3+temporal

WALK: session-graph hops from the REAL base-search hit sessions (hits from
books-full2 dumps = the actual context_search top-8; identical across variants,
so recall parity holds by construction). H=1 hop ~= current recall_thread depth-2
chunk walk; H=2 reported too (needs a deeper walk in the real build).
ADMISSION: score(s) = max edge-sim connecting s to phase-1 (H=2: bottleneck min);
temporal edges score = actual pair sim if >=0.45 else 0.449. Floors F swept.
ASSEMBLY: phase1 first (never displaced), then admitted by score desc, same
budget as arm B/C: 36 chunks / 112000 chars.
"""
import json, os, glob, sys
from collections import defaultdict

BOOKS = 'longmemeval-baseline/books-full2'
H68 = 'longmemeval-baseline/headroom68.qids'
GE_CAP, GE_CHAR_BUDGET = 36, 112000
T = 0.5  # inference threshold (the sweep-winning ingest threshold)

# ---- load chunk metadata + pairs ----
chunk_sess = {}                       # ctx_id -> sess int
proj_chunks = defaultdict(list)       # project -> [(ts, ctx_id, sess)]
for line in open('/tmp/dens_chunks.tsv'):
    p, cid, sess, ts = line.rstrip('\n').split('\t')
    if sess == '':
        continue
    chunk_sess[cid] = int(sess)
    proj_chunks[p].append((float(ts), cid, int(sess)))
for p in proj_chunks:
    proj_chunks[p].sort()

proj_pairs = defaultdict(list)        # project -> [(later, earlier, sim)]
for line in open('/tmp/dens_pairs.tsv'):
    p, lid, eid, sim = line.rstrip('\n').split('\t')
    proj_pairs[p].append((lid, eid, float(sim)))

def heads_of(p):
    """head chunk id per session = earliest ts chunk of that session."""
    h = {}
    for ts, cid, s in proj_chunks[p]:
        if s not in h:
            h[s] = cid
    return h

def sess_order(p):
    """sessions in chronological (ingest) order."""
    seen, order = set(), []
    for ts, cid, s in proj_chunks[p]:
        if s not in seen:
            seen.add(s)
            order.append(s)
    return order

# per-project: later_id -> [(sim, earlier_id)] sorted desc, for topK selection
def later_index(p):
    idx = defaultdict(list)
    for lid, eid, sim in proj_pairs[p]:
        idx[lid].append((sim, eid))
    for lid in idx:
        idx[lid].sort(reverse=True)
    return idx

# ---- edge derivation per variant: returns session-level edges {(a,b): score} ----
def derive(p, variant):
    hs = heads_of(p)
    head_ids = set(hs.values())
    idx = later_index(p)
    edges = {}
    def add(cid1, cid2, sim):
        a, b = chunk_sess.get(cid1), chunk_sess.get(cid2)
        if a is None or b is None or a == b:
            return
        k = (min(a, b), max(a, b))
        if sim > edges.get(k, 0):
            edges[k] = sim
    name, _, arg = variant.partition(':')
    if name in ('base1', 'khead', 'kall'):
        K = 1 if name == 'base1' else int(arg)
        writers = head_ids if name in ('base1', 'khead') else set(chunk_sess)
        for ts, cid, s in proj_chunks[p]:
            if cid not in writers:
                continue
            n = 0
            for sim, eid in idx.get(cid, []):
                if sim < T:
                    break
                # skip same-session candidates (they add no cross edge)
                if chunk_sess.get(eid) == s:
                    continue
                add(cid, eid, sim)
                n += 1
                if n >= K:
                    break
    elif name == 'sess':
        K = int(arg)
        for ts, cid, s in proj_chunks[p]:
            if cid not in head_ids:
                continue
            n = 0
            for sim, eid in idx.get(cid, []):
                if sim < T:
                    break
                if eid not in head_ids or chunk_sess.get(eid) == s:
                    continue
                add(cid, eid, sim)
                n += 1
                if n >= K:
                    break
    elif name == 'temporal':
        order = sess_order(p)
        # sim of the head pair if dumped, else structural floor 0.449
        pair_sim = {}
        for lid, eid, sim in proj_pairs[p]:
            a, b = chunk_sess.get(lid), chunk_sess.get(eid)
            if a is None or b is None or a == b:
                continue
            k = (min(a, b), max(a, b))
            pair_sim[k] = max(pair_sim.get(k, 0), sim)
        for i in range(1, len(order)):
            a, b = order[i - 1], order[i]
            k = (min(a, b), max(a, b))
            edges[k] = max(edges.get(k, 0), pair_sim.get(k, 0.449))
    else:
        raise ValueError(variant)
    return edges

def combine(*edge_sets):
    out = {}
    for es in edge_sets:
        for k, v in es.items():
            if v > out.get(k, 0):
                out[k] = v
    return out

# ---- walk + admission + assembly ----
def evaluate(dump, edges, hops, F):
    phase1 = dump['phase1']
    p1 = set(phase1)
    adj = defaultdict(list)
    for (a, b), sim in edges.items():
        adj[a].append((b, sim))
        adj[b].append((a, sim))
    # hop 1
    score = {}
    for s in p1:
        for t2, sim in adj[s]:
            if t2 not in p1:
                score[t2] = max(score.get(t2, 0), sim)
    if hops == 2:
        for s1, sc1 in list(score.items()):
            for t2, sim in adj[s1]:
                if t2 not in p1 and t2 not in score:
                    score[t2] = max(score.get(t2, 0), min(sc1, sim))
    admitted = [s for s, v in sorted(score.items(), key=lambda x: (-x[1], x[0]))
                if v >= F]
    sizes = {int(k): v for k, v in dump['sess_sizes'].items()}
    gold = set(dump['gold_idx'])
    used, tc, ch, parts = [], 0, 0, 0
    for si in list(phase1) + admitted:
        c = sizes.get(si, [])
        bl = sum(c) + max(0, len(c) - 1)
        if parts and (tc + len(c) > GE_CAP or ch + bl > GE_CHAR_BUDGET):
            if si in p1:
                continue
            break
        parts += 1; tc += len(c); ch += bl; used.append(si)
        if tc >= GE_CAP or ch >= GE_CHAR_BUDGET:
            break
    us = set(used)
    cov = len(gold & us) / max(1, len(gold))
    p2u = [s for s in used if s not in p1]
    p2g = sum(1 for s in p2u if s in gold)
    junk = len(p2u) - p2g
    junk_ch = sum(sum(sizes.get(s, [])) for s in p2u if s not in gold)
    return cov, p2g, junk, junk_ch

def main():
    h68 = set(l.strip() for l in open(H68) if l.strip())
    dumps = {}
    for fp in glob.glob(os.path.join(BOOKS, '*.json')):
        d = json.load(open(fp))
        if not d.get('abstention'):
            dumps[d['question_id']] = d
    print(f'answerable dumps: {len(dumps)}  h68: {len(h68 & set(dumps))}')

    variants = [
        ('base1', ['base1']),
        ('khead2', ['khead:2']), ('khead3', ['khead:3']), ('khead5', ['khead:5']),
        ('kall2', ['kall:2']), ('kall3', ['kall:3']),
        ('sess3', ['sess:3']),
        ('temporal', ['temporal']),
        ('khead3+temp', ['khead:3', 'temporal']),
        ('kall2+temp', ['kall:2', 'temporal']),
        ('sess3+temp', ['sess:3', 'temporal']),
    ]
    grid = [(1, 0.0), (1, 0.5), (1, 0.55), (2, 0.0), (2, 0.5)]
    # precompute edges per project per primitive
    prim_cache = {}
    def edges_for(p, prims):
        out = []
        for pr in prims:
            key = (p, pr)
            if key not in prim_cache:
                prim_cache[key] = derive(p, pr)
            out.append(prim_cache[key])
        return combine(*out)

    print(f"\n{'variant':<14}{'hops':>4}{'F':>6} | {'FULL500: fullcov%':>18}{'meancov':>8} | "
          f"{'H68: fullcov':>12}{'meancov':>8} | {'junk/q':>7}{'junkKch/q':>10}{'edges/q':>8}")
    results = []
    for vname, prims in variants:
        for hops, F in grid:
            covs_all, covs_h68 = [], []
            fj = fg = fjc = 0
            n_edges = 0
            for qid, d in dumps.items():
                p = f'lmec-{qid}'.lower()[:60]
                edges = edges_for(p, prims)
                n_edges += len(edges)
                cov, p2g, junk, jch = evaluate(d, edges, hops, F)
                covs_all.append(cov)
                if qid in h68:
                    covs_h68.append(cov)
                fg += p2g; fj += junk; fjc += jch
            n = len(covs_all)
            full_rate = sum(1 for c in covs_all if c >= 1.0) / n
            row = {'variant': vname, 'hops': hops, 'F': F,
                   'full500_fullcov': full_rate,
                   'full500_meancov': sum(covs_all) / n,
                   'h68_fullcov': sum(1 for c in covs_h68 if c >= 1.0),
                   'h68_meancov': sum(covs_h68) / max(1, len(covs_h68)),
                   'junk_per_q': fj / n, 'junkKch_per_q': fjc / n / 1000,
                   'edges_per_q': n_edges / n, 'p2gold_total': fg}
            results.append(row)
            print(f"{vname:<14}{hops:>4}{F:>6} | {full_rate*100:>17.1f}%"
                  f"{row['full500_meancov']:>8.3f} | {row['h68_fullcov']:>12}"
                  f"{row['h68_meancov']:>8.3f} | {row['junk_per_q']:>7.2f}"
                  f"{row['junkKch_per_q']:>10.1f}{row['edges_per_q']:>8.1f}")
    json.dump(results, open('/tmp/densify_results.json', 'w'), indent=1)
    print('\nvector-only baseline: full500 fullcov = 85.5% (402/470), h68 fullcov=0, meancov(h68)=0.485')

if __name__ == '__main__':
    main()
