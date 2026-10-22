#!/usr/bin/env python3
"""$0 OFFLINE sweep of the phase-2 admission rule over dumped graph bookkeeping.

Replays the EXACT assembly logic of moat_pilot.retrieve_graph per config
(simfloor F x p2max) against per-question dumps produced with --dump-book,
for each ingest threshold T (one dump dir per T). No Mandrel, no OpenAI: $0.

Metrics per config, over the 68-question hard slice:
  - mean in-context gold coverage (PRIMARY -- the discovery win)
  - # questions at FULL gold coverage
  - p2 gold admitted / p2 junk admitted (dilution accounting)
  - junk chars added (dilution proxy the temporal regressions warned about)
Selection: max mean coverage; ties (within 0.005) -> min junk chars.
"""
import json, os, sys, glob

sys.path.insert(0, 'longmemeval-baseline')
import moat_pilot as MP  # single source for admit_phase2 + budget constants

GE_CAP, GE_CHAR_BUDGET = MP.GE_CAP, MP.GE_CHAR_BUDGET


def simulate(dump, simfloor, p2max):
    phase1 = dump['phase1']
    admitted, _sc = MP.admit_phase2(dump['p2_candidates'], phase1,
                                    [tuple(e) for e in dump['edges']],
                                    simfloor=simfloor, p2max=p2max)
    sizes = {int(k): v for k, v in dump['sess_sizes'].items()}
    gold = set(dump['gold_idx'])
    used, total_chunks, chars = [], 0, 0
    parts = 0
    for si in list(phase1) + admitted:
        ch = sizes.get(si, [])
        block_len = sum(ch) + max(0, len(ch) - 1)  # newline joins
        nb = len(ch)
        if parts and (total_chunks + nb > GE_CAP or chars + block_len > GE_CHAR_BUDGET):
            if si in phase1:
                continue
            break
        parts += 1
        total_chunks += nb
        chars += block_len
        used.append(si)
        if total_chunks >= GE_CAP or chars >= GE_CHAR_BUDGET:
            break
    used_set = set(used)
    cov = len(gold & used_set) / max(1, len(gold))
    p2_used = [s for s in used if s not in set(phase1)]
    p2_gold = sum(1 for s in p2_used if s in gold)
    p2_junk = len(p2_used) - p2_gold
    junk_chars = sum(sum(sizes.get(s, [])) for s in p2_used if s not in gold)
    return cov, p2_gold, p2_junk, junk_chars


def main():
    results = []
    for tdir, tlabel in [(sys.argv[1], sys.argv[2]), (sys.argv[3], sys.argv[4])] \
            if len(sys.argv) > 4 else [(sys.argv[1], sys.argv[2])]:
        dumps = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(tdir, '*.json')))]
        print(f'\n=== ingest threshold T={tlabel}  ({len(dumps)} questions) ===')
        print(f"{'F':>5} {'p2max':>6} {'meancov':>8} {'full':>5} "
              f"{'p2gold':>7} {'p2junk':>7} {'junkKchars':>10}")
        for F in [0.0, 0.5, 0.55, 0.6, 0.65]:
            for p2max in [0, 2]:
                covs, g, j, jc = [], 0, 0, 0
                for d in dumps:
                    c, pg, pj, pjc = simulate(d, F, p2max)
                    covs.append(c)
                    g += pg; j += pj; jc += pjc
                mean_cov = sum(covs) / len(covs)
                full = sum(1 for c in covs if c >= 1.0)
                results.append({'T': tlabel, 'F': F, 'p2max': p2max,
                                'mean_cov': mean_cov, 'full': full,
                                'p2gold': g, 'p2junk': j, 'junk_chars': jc})
                print(f"{F:>5} {p2max:>6} {mean_cov:>8.3f} {full:>5} "
                      f"{g:>7} {j:>7} {jc/1000:>10.0f}")
    best_cov = max(r['mean_cov'] for r in results)
    cands = [r for r in results if r['mean_cov'] >= best_cov - 0.005]
    winner = min(cands, key=lambda r: r['junk_chars'])
    print('\nWINNER (max coverage, min junk within 0.005):', json.dumps(winner))
    print('ARM B baseline on this slice: mean_cov=0.485, full=0')


if __name__ == '__main__':
    main()
